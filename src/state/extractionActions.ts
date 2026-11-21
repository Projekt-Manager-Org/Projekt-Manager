/**
 * Extraction-modal actions — thin wrappers around API calls with session handling.
 *
 * The UI layer must not import @/api/client directly (ARCHITECTURE.md §
 * Architecture Overview). These functions provide the same operations the
 * EmailExtractModal needs, routed through the state layer with proper
 * session-expiry delegation.
 */

import { extractApi, customerApi, projectApi } from '@/api/client';
import { handleSessionExpired } from './sessionExpired';
import type { Customer } from '@/domain/types';

export async function extractFromEmail(text: string) {
  const result = await extractApi.extract(text);
  if (!result.ok && result.sessionExpired) handleSessionExpired();
  return result;
}

/** Whether the server can extract (AC-734). Any failure reads as "not
 * configured": hiding the entry beats offering one that cannot work. */
export async function fetchExtractionConfigured(): Promise<boolean> {
  const result = await extractApi.status();
  if (!result.ok) {
    if (result.sessionExpired) handleSessionExpired();
    return false;
  }
  return result.data.configured;
}

export async function searchCustomers(query: string): Promise<Customer[]> {
  const result = await customerApi.list({ search: query });
  if (!result.ok) {
    if (result.sessionExpired) handleSessionExpired();
    return [];
  }
  return result.data.customers;
}

export async function createCustomerFromExtraction(data: {
  id?: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: { street: string; zip: string; city: string } | null;
}) {
  const result = await customerApi.create(data);
  if (!result.ok && result.sessionExpired) handleSessionExpired();
  return result;
}

export async function createProjectFromExtraction(data: {
  id?: string;
  number: string;
  title: string;
  customerId: string;
  siteAddress?: { street: string; zip: string; city: string } | null;
}) {
  const result = await projectApi.create(data);
  if (!result.ok && result.sessionExpired) handleSessionExpired();
  return result;
}
