# "Projekt-Manager"

## Purpose

A centralized system for consolidation, control, and viewing of data and processes in a small, German-speaking "Handwerker" company.

The core motivation: **making inaction visible**. The system exists to ensure that every pending action — an unanswered inquiry, an unscheduled job, an unsent invoice — is impossible to overlook.

## Target

Even if the spark for this project came from a particular company, the observed anti-patterns are unfortunately widely spread and the approach in this project could definitely benefit much broader target than the single company where the pilot project would be run. Thus, the project will be developed in a generalized way (covering the target one or similar companies), while all customer specific details would be integrated in a separate, closed codebase.

## Background

There are no processes or workflows defined or even realized. Work is done on a reactive basis, responding to the current most noticeable signal of discomfort - missed deadline, forgotten document, etc. A general overview, providing up-to-date information about which projects are currently executing in the company, with their current state, which are planned or in the pre-project phase of marketing/negotiation/offer, which are done with which results - all this information exists ideally only in the head of the owner, or worse - are distributed in the heads of the owner and other involved persons. Data is frequently lost, priorities are often misplaced, negative effects accumulate up to the point of financial and legal trouble. One extreme example would be the missing of an invoice because no one thought of it.
There is no centralized system to process or store data - tools and processes are used ad-hoc, leading to a large amount of different, incoherent technologies in use. A vast amount of manual work is needed to operate and synchronize the data across all these. As some prime examples are the use of chatting apps like WhatsApp for the transfer of information, sharing bigger files through uploading them to Dropbox or Google Drive, manual extraction of customer data from the email application, different applications for saving project and customer data, bookkeeping, etc. A very real and often underestimated effect of this state of affairs, is the psychological and physical toll this takes on all involved, leading to a death spiral of even more errors and more stress.

## Scope

The general inclusion of all internal processes in a single, centralized data system, needs to be tailored to the needs of every specific company, or, alternatively be made extremely customizable, with the necessary explosion in complexity. Thus, this project would focus on the main workflow in a small "Handwerker" company:

| State               | Type   | What happens                                                                |
| ------------------- | ------ | --------------------------------------------------------------------------- |
| **Anfrage**         | Action | Customer inquiry received — company must write an offer                     |
| **Angebot**         | Buffer | Offer sent — waiting for customer confirmation                              |
| **Beauftragt**      | Action | Customer confirmed — company must plan and schedule                         |
| **Geplant**         | Buffer | Planned — waiting for its turn on the calendar                              |
| **In Arbeit**       | Active | Project is being executed (incl. producing artifacts: Aufmaß, photos, etc.) |
| **Abnahme**         | Buffer | Execution complete — waiting for customer acceptance                        |
| **Rechnung fällig** | Action | Customer accepted — company must write the invoice                          |
| **Abgerechnet**     | Buffer | Invoice sent — waiting for payment                                          |
| **Erledigt**        | Done   | Payment received — project closed                                           |

Action states are where the company must act. Buffer states are where the project is blocked, waiting for an external event. The Kanban board makes both naturally visible — items accumulating in an action column immediately signal that work is falling behind.

The main goal would be to have a readily available, up-to-date information about the state of all projects across the above workflow. We define only a couple of main groups for simplicity and because of their matching interests - an owner, an office manager, workers and a bookkeeper, then setup an appropriate view of the information of interest to them, including providing ways to process it, within the limits of their user rights.

## Company specifics

Reasonable assumptions will be made in regards of all company-specific details. Wherever such assumptions are made, the details affected will be set up to be configurable, to allow full customization to the concrete needs of the particular company. The motivation behind this is twofold:

- protecting the private details of the company and
- providing a highly adjustable system to be used by a wider variety of similar companies.

## Target environment

- generally non-technical users. Web-based services are preferred, local installation of software is generally to be avoided;
- installation of web-apps (PWA) is acceptable;
- Thunderbird or other external email client;
- orgaMAX, or similar bookkeeping software, contains currently all customer data, manually maintained;
- Windows OS, Android smartphones, office PCs and laptops;
- no server hardware currently available - a managed hosting will be purchased. Details are to be decided with regard to stack and costs.
  (the above list already contains some assumptions as per the earlier section of this document)

## Done when (final product)

- Customer data, arriving in emails, can be extracted using LLMs and fed into the main system in a user-friendly, trivial way;
- All customer's and project's data is saved and managed in the central system. UIs are available for easily working with and previewing the data;
- A calendar overview is available, where the projects can be seen and planned;
- A Kanban view is available, where all tasks are shown in the three simple groups - waiting, in progress, done. Proper colors, formatting, etc. are to be used to discern among different types of tasks and their belonging to the projects;
- A "worker" view is available, where only the relevant projects are shown to the particular worker, on a calendar/Kanban view. Detailed view, with information the worker needs - such as object data, GPS coordinates, etc., if available, are also presented;
- The worker has the option to add notes and information, as well as upload pictures, Aufmass, etc.
- The system takes care to optimize the binary files for size and organize them into a neat structure. Alerts are sent when approaching predefined limits on space;
- The system maintains a configurable list of events and list of persons who are to be notified when these events trigger. Any form of notification is acceptable, as long it can be delivered instanteneously under standard circumstances;
- The system consists of modules with a clear separation of concerns. Data moves between them following well established, open standards, allowing the integration of new modules, import/export and the customization of the whole system (see [Company specifics](#company-specifics)).
- A simplified view for the bookkeeper includes a list of all invoices, with the option for searching, grouping and exporting them;
- An administrator's view is available, where users, groups and rights can be set and changed;
- All internals and developer information is in English, all user facing information - in German;
- End-to-End tests are defined and executed on all integrations (CI);
- A semi-automated, operator-in-the-loop system for deployment;
- A detailed "Handbuch" in German is provided, describing in detail and with the help of screenshots, diagrams, etc. the functions of the system in a user-friendly way;
- Tooltips, hints, help information and others as needed are provided in the UI as well;
- The company's data from the database is backed up automatically at regular intervals to counteract the app's potential unreliability.

## Not Doing

- No feature requests beyond what we define in this document ("System does what the spec says but they want it different")
- AI features beyond extracting data from emails
- Extraction of data from the software currently in use
- No sysadmin work
- A backup concept and a backup system beyond the defined in the section above
- Disk space management (notifications are planned when reaching a threshold, cleanup is up to the users)
- General replacement of WhatsApp
- Bookkeeping software
- Payroll or time tracking
- Inventory / materials management
- Customer-facing views of the system (customer =/= stakeholder for this context)
- Other stakeholders than those described above
- Automated scheduling / route optimization / other automations
- GPS tracking of crews
- Integration with anything not mentioned here (Google Calendar, email automation, etc.)
- Continuous Delivery (CD) is out of scope for reasons of security and operational burden
- Generalization of the project beyond the needs of the target company (possible use in _similar_ companies after adjustment)
- Responsibility for content, law and tax obligations stay with the company

## First demo checkpoint (Iteration 1)

The walking skeleton — a subset of the final product above, scoped to a single iteration:

- demonstration of consolidated preview of the state of projects - a calendar and a Kanban view (including for example "you have X completed projects without invoice"), using mock data, with basic interactivity (date changes, state transitions, project card view).
