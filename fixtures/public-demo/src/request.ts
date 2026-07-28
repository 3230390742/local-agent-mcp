export interface ListRequest { page?: string; pageSize?: string }

export function parseListRequest(input: ListRequest) {
  return {
    page: Number(input.page ?? "1"),
    pageSize: Number(input.pageSize ?? "20"),
  };
}
