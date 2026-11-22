/**
 * Extraction service — LLM-based email data extraction via OpenRouter.
 *
 * Takes raw email text, sends it to OpenRouter with a structured prompt,
 * and returns extracted customer + project fields. See ADR-0016.
 */

import { getEnv } from '../config/env.js';
import { featureStatus } from '../config/features.js';
import { STRINGS } from '../../config/strings.js';
import { ADDRESS_MAX } from '../../domain/address.js';
import { validationError, serverError } from '../errors.js';
import type { ServiceLogger } from './Logger.js';

export interface ExtractionResult {
  customer: {
    name: string | null;
    phone: string | null;
    email: string | null;
    street: string | null;
    zip: string | null;
    city: string | null;
  };
  project: {
    title: string | null;
    description: string | null;
    // Baustellen-/Leistungsadresse, distinct from the customer's
    // Rechnungsadresse (data-model.md §5.1). Strict shape — either all
    // three fields are non-empty strings or the value is null. The LLM
    // may return a partial object; the service collapses partials to
    // null so callers can treat null as "site = customer address" by
    // the fallback rule without re-validating field counts.
    siteAddress: { street: string; zip: string; city: string } | null;
  };
}

const SYSTEM_PROMPT = `Du bist ein Datenextraktor für ein Handwerker-Projektmanagement-System.
Extrahiere aus der folgenden E-Mail die Kundendaten und Projektdaten.

Das System unterscheidet zwei Adressen:
- Kundenadresse (Rechnungsadresse): die rechtliche Anschrift des Kunden — gehört unter "customer".
- Baustellenadresse (Leistungsadresse): der Ort, an dem die Arbeit ausgeführt wird — gehört unter "project.siteAddress".

Antworte ausschließlich mit validem JSON im folgenden Format, ohne Erklärungen:
{
  "customer": {
    "name": "Kundenname oder null",
    "phone": "Telefonnummer oder null",
    "email": "E-Mail-Adresse oder null",
    "street": "Straße und Hausnummer oder null",
    "zip": "Postleitzahl oder null",
    "city": "Ort oder null"
  },
  "project": {
    "title": "Kurzer Projekttitel oder null",
    "description": "Kurze Projektbeschreibung oder null",
    "siteAddress": null
  }
}

Regeln:
- Extrahiere nur Informationen, die tatsächlich in der E-Mail stehen.
- Setze Felder auf null, wenn die Information nicht vorhanden ist.
- Der Projekttitel soll kurz und beschreibend sein (z.B. "Fassadenanstrich Einfamilienhaus").
- Kundenname: bevorzuge den Firmennamen, falls vorhanden, sonst den Personennamen.
- Wenn die E-Mail nur eine einzige Adresse enthält, gehört sie zu "customer" und project.siteAddress bleibt null.
- Setze project.siteAddress nur dann auf ein Objekt { "street", "zip", "city" }, wenn die E-Mail eine zweite, klar abweichende Baustellenadresse nennt (typisch: Hausverwaltung, Vermieter, Bauträger). Alle drei Felder müssen befüllt sein; sonst project.siteAddress = null.`;

/**
 * Validate and clamp an LLM-extracted field: must be a string or null,
 * truncated to maxLen, the field's limit. Non-string values → null.
 */
function clampStr(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

export class ExtractionService {
  async extract(emailText: string, log: ServiceLogger): Promise<ExtractionResult> {
    const env = getEnv();

    if (!emailText.trim()) {
      throw validationError(STRINGS.extraction.emptyInput);
    }

    // Missing configuration is the operator's fault, not the caller's
    // (AC-738): a server error that names nothing; the log says why.
    if (!featureStatus(env, 'llm').enabled) {
      log.error({}, 'extraction_not_configured');
      throw serverError();
    }

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model: env.OPENROUTER_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: emailText },
          ],
        }),
      });

      if (!response.ok) {
        log.error({ status: response.status }, 'openrouter_api_error');
        throw serverError();
      }

      const data = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };

      const rawContent = data.choices?.[0]?.message?.content;
      if (!rawContent) {
        log.error({}, 'openrouter_empty_response');
        throw serverError();
      }

      // Strip markdown code fences — LLMs often wrap JSON in ```json ... ```
      // Try boundary-based stripping first, fall back to finding first { and last }
      let content = rawContent.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      if (!content.trimStart().startsWith('{')) {
        const first = rawContent.indexOf('{');
        const last = rawContent.lastIndexOf('}');
        if (first !== -1 && last > first) {
          content = rawContent.slice(first, last + 1);
        }
      }

      const parsed = JSON.parse(content) as Record<string, unknown>;

      // Runtime validation: ensure the parsed structure has the expected shape
      // and all fields are strings or null, clamped to the field limits (data-model.md §5.1, §5.6).
      const customer =
        typeof parsed.customer === 'object' && parsed.customer !== null
          ? (parsed.customer as Record<string, unknown>)
          : {};
      const project =
        typeof parsed.project === 'object' && parsed.project !== null
          ? (parsed.project as Record<string, unknown>)
          : {};

      // siteAddress is all-or-none: a partial object (e.g. only street)
      // collapses to null. The LLM is instructed to emit a full triple
      // or null, but enforcing the rule here means callers do not need
      // to revalidate, and an over-eager model that leaks "street only"
      // does not propagate a malformed shape downstream.
      const rawSite =
        typeof project.siteAddress === 'object' && project.siteAddress !== null
          ? (project.siteAddress as Record<string, unknown>)
          : null;
      const siteStreet = rawSite ? clampStr(rawSite.street, ADDRESS_MAX.street) : null;
      const siteZip = rawSite ? clampStr(rawSite.zip, ADDRESS_MAX.zip) : null;
      const siteCity = rawSite ? clampStr(rawSite.city, ADDRESS_MAX.city) : null;
      const siteAddress =
        siteStreet && siteZip && siteCity
          ? { street: siteStreet, zip: siteZip, city: siteCity }
          : null;

      log.info({}, 'extraction_completed');
      return {
        customer: {
          name: clampStr(customer.name, 255),
          phone: clampStr(customer.phone, 100),
          email: clampStr(customer.email, 255),
          street: clampStr(customer.street, ADDRESS_MAX.street),
          zip: clampStr(customer.zip, ADDRESS_MAX.zip),
          city: clampStr(customer.city, ADDRESS_MAX.city),
        },
        project: {
          title: clampStr(project.title, 500),
          description: clampStr(project.description, 10000),
          siteAddress,
        },
      };
    } catch (err) {
      if (err instanceof SyntaxError) {
        log.error({ err }, 'extraction_json_parse_failed');
        throw serverError();
      }
      throw err;
    }
  }
}
