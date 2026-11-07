/**
 * Customer management view — list, create, edit, delete customers.
 *
 * Test IDs follow the established naming convention (kebab-case).
 * See e2e/management-flows.spec.ts steps 18.
 */

import { useEffect, useRef, useState } from 'react';
import { useCustomerStore, type CustomerSortKey } from '@/state/customerStore';
import { usePermission } from '@/hooks/usePermission';
import { useConfirmStore } from '@/state/confirmStore';
import { STRINGS } from '@/config/strings';
import type { Customer } from '@/domain/types';
import { SortableHeader, type SortDirection } from '@/ui/common/SortableHeader';
import { CustomerCreateForm } from './CustomerCreateForm';
import { CustomerEditForm } from './CustomerEditForm';
import styles from './Management.module.css';

export function CustomerManagement() {
  const customers = useCustomerStore((s) => s.customers);
  const loading = useCustomerStore((s) => s.loading);
  const error = useCustomerStore((s) => s.error);
  const search = useCustomerStore((s) => s.search);
  const sortBy = useCustomerStore((s) => s.sortBy);
  const sortDir = useCustomerStore((s) => s.sortDir);
  const fetchCustomers = useCustomerStore((s) => s.fetchCustomers);
  const fetchCustomerDetail = useCustomerStore((s) => s.fetchCustomerDetail);
  const deleteCustomer = useCustomerStore((s) => s.deleteCustomer);
  const setSearch = useCustomerStore((s) => s.setSearch);
  const setSort = useCustomerStore((s) => s.setSort);
  const clearError = useCustomerStore((s) => s.clearError);
  const requestConfirm = useConfirmStore((s) => s.request);

  const canWrite = usePermission('customer:write');
  const canDelete = usePermission('customer:delete');

  const [formOpen, setFormOpen] = useState(false);
  const [editCustomer, setEditCustomer] = useState<Customer | null>(null);

  // Mount fetch — uses whatever search/sort the store already holds
  // (defaults to name asc + empty search on fresh load).
  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  // Debounced search — skip the initial render (the mount effect above
  // already issued a fetch with the same baseline).
  const prevSearch = useRef(search);
  useEffect(() => {
    if (search === prevSearch.current) return;
    prevSearch.current = search;
    const timer = setTimeout(() => {
      fetchCustomers();
    }, 300);
    return () => clearTimeout(timer);
  }, [search, fetchCustomers]);

  // Sort change refetches immediately — no debounce, the trigger is a
  // discrete click, not free-text input.
  const prevSort = useRef({ sortBy, sortDir });
  useEffect(() => {
    if (prevSort.current.sortBy === sortBy && prevSort.current.sortDir === sortDir) return;
    prevSort.current = { sortBy, sortDir };
    fetchCustomers();
  }, [sortBy, sortDir, fetchCustomers]);

  const handleDelete = async (e: React.MouseEvent, customer: Customer) => {
    e.stopPropagation();
    // AC-534: before confirming, fetch the customer to learn how many
    // archived projects will be purged alongside it. If the fetch fails
    // the store already wrote the error — abort silently here (AC-533).
    // Falling back to the generic confirm would hide a potential warning
    // about data loss.
    const detail = await fetchCustomerDetail(customer.id);
    if (!detail) return;
    const archivedCount = detail.archivedProjectCount;
    const message =
      archivedCount > 0
        ? STRINGS.customers.deleteWithArchived(archivedCount)
        : STRINGS.ui.deleteConfirm(customer.name);
    const confirmed = await requestConfirm(message);
    if (!confirmed) return;
    await deleteCustomer(customer.id);
  };

  const handleRowClick = (customer: Customer) => {
    clearError();
    setEditCustomer(customer);
  };

  const openCreateForm = () => {
    clearError();
    setEditCustomer(null);
    setFormOpen(true);
  };

  // When the create form's duplicate-name dropdown is used to pick an
  // existing customer, flip the create form into an edit against that row.
  const openEditFromMatch = (customer: Customer) => {
    setFormOpen(false);
    handleRowClick(customer);
  };

  const handleSort = (column: CustomerSortKey, direction: SortDirection) => {
    setSort(column, direction);
  };

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        {canWrite && (
          <button
            className={styles.createButton}
            onClick={openCreateForm}
            data-testid="customer-create-button"
          >
            {STRINGS.ui.create}
          </button>
        )}
        <input
          className={styles.searchInput}
          placeholder={STRINGS.ui.search}
          aria-label={STRINGS.ui.search}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="customer-search"
        />
      </div>

      {error && !formOpen && !editCustomer && <div className={styles.error}>{error}</div>}

      <table className={styles.table} data-testid="customer-table">
        <thead>
          <tr>
            <SortableHeader<CustomerSortKey>
              column="name"
              activeColumn={sortBy}
              direction={sortDir}
              onSort={handleSort}
              testId="customer-sort-name"
            >
              {STRINGS.ui.name}
            </SortableHeader>
            <SortableHeader<CustomerSortKey>
              column="phone"
              activeColumn={sortBy}
              direction={sortDir}
              onSort={handleSort}
              testId="customer-sort-phone"
            >
              {STRINGS.ui.phone}
            </SortableHeader>
            <SortableHeader<CustomerSortKey>
              column="email"
              activeColumn={sortBy}
              direction={sortDir}
              onSort={handleSort}
              testId="customer-sort-email"
            >
              {STRINGS.ui.email}
            </SortableHeader>
            <SortableHeader<CustomerSortKey>
              column="city"
              activeColumn={sortBy}
              direction={sortDir}
              onSort={handleSort}
              testId="customer-sort-city"
            >
              {STRINGS.ui.city}
            </SortableHeader>
            {canDelete && <th>{STRINGS.ui.actions}</th>}
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.id} className={styles.clickableRow} onClick={() => handleRowClick(c)}>
              <td data-label={STRINGS.ui.name}>{c.name}</td>
              <td data-label={STRINGS.ui.phone}>{c.phone ?? '—'}</td>
              <td data-label={STRINGS.ui.email}>{c.email ?? '—'}</td>
              <td data-label={STRINGS.ui.city}>{c.address?.city ?? '—'}</td>
              {canDelete && (
                <td>
                  <button className={styles.dangerButton} onClick={(e) => handleDelete(e, c)}>
                    {STRINGS.ui.delete}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {!loading && customers.length === 0 && (
        <div className={styles.noResults}>{STRINGS.ui.noResults}</div>
      )}

      {formOpen && (
        <CustomerCreateForm
          onClose={() => setFormOpen(false)}
          onSelectExisting={openEditFromMatch}
        />
      )}

      {editCustomer && !formOpen && (
        <CustomerEditForm customer={editCustomer} onClose={() => setEditCustomer(null)} />
      )}
    </div>
  );
}
