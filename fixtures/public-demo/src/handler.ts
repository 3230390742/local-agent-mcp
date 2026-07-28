import { parseListRequest, type ListRequest } from "./request.js";

export function handleList(input: ListRequest) {
  const query = parseListRequest(input);
  return { offset: (query.page - 1) * query.pageSize, limit: query.pageSize };
}
