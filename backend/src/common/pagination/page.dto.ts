/** Standard envelope for every paginated list. */
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export const emptyPage = <T>(page: number, pageSize: number): Page<T> => ({
  items: [],
  page,
  pageSize,
  total: 0,
});
