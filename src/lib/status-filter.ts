/**
 * What `?status=` means on the two workflow listings (`GET /workflows` and
 * `GET /public/workflows`).
 *
 * A workflow is only runnable when BOTH status axes say so: its own per-version
 * `status` is 'active' AND its dynasty's `workflow_dynasty_status` is 'active'.
 * The listings are what rankers and pickers read to choose something to run
 * (campaign-service provisions a funnel campaign off `status=active`;
 * features-service builds its projection off `/public/workflows`), so "active"
 * on those surfaces has to mean *executable* rather than merely
 * "this version is the latest of its lineage". Otherwise a retired dynasty keeps
 * being offered, gets picked, and every resulting execute is refused with a 410.
 *
 * The three cases partition the same set: `retired` is exactly the complement of
 * `executable`, and `all` is their union.
 */
export type StatusFilter =
  /** No status constraint at all. */
  | { kind: "all" }
  /** Runnable: version active AND dynasty active. */
  | { kind: "executable" }
  /** Not runnable: version deprecated OR dynasty deprecated. */
  | { kind: "retired" }
  /** An explicit per-version status that is neither of the two known values. */
  | { kind: "versionStatus"; value: string };

export function resolveStatusFilter(status: string | undefined): StatusFilter {
  if (status === "all") return { kind: "all" };
  // Absent means the default, and the default is the runnable set.
  if (status === undefined || status === "active") return { kind: "executable" };
  if (status === "deprecated") return { kind: "retired" };
  return { kind: "versionStatus", value: status };
}
