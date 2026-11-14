/** Producer readers validate names/layouts; rerun ordering has one owner. */
export function latestAttempts(records) {
  const latest = new Map();
  for (const record of records) {
    const attempt = Number(record.attempt);
    if (!latest.has(record.id) || attempt > latest.get(record.id).attempt)
      latest.set(record.id, { ...record, attempt });
  }
  return [...latest.values()];
}
