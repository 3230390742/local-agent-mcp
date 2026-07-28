export function formatRecordFailure(error: unknown): string {
  return error instanceof Error && error.message === "public scenario did not fully pass"
    ? "public scenario did not fully pass"
    : "public demo record failed";
}

export function formatAuditFailure(_error: unknown): string {
  return "public demo audit failed";
}
