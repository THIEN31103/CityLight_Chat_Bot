// Server-paginated table (components/DataTable.tsx): column picker and pager.
import { defineDict } from '@citylight/shared';

export const TABLE = defineDict(
  {
    columns: 'Cột',
    /** count = number of rows, rows = the same number formatted */
    summary: (_count: number, rows: string, page: number, pages: number) => `${rows} dòng · trang ${page}/${pages}`,
    perPage: '{n} / trang',
    prev: 'Trang trước',
    next: 'Trang sau',
  },
  {
    columns: 'Columns',
    summary: (count: number, rows: string, page: number, pages: number) => `${rows} ${count === 1 ? 'row' : 'rows'} · page ${page}/${pages}`,
    perPage: '{n} / page',
    prev: 'Previous page',
    next: 'Next page',
  },
);
