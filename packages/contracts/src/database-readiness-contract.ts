import { z } from "zod";

const databaseReadinessRowsSchema = z
  .array(
    z.strictObject({
      currentRole: z.literal("app_dal"),
      currentRoleRestricted: z.boolean(),
      ready: z.boolean(),
      sessionMembershipRestricted: z.boolean(),
      sessionRestricted: z.boolean(),
      sessionRole: z.string().min(1),
    }),
  )
  .length(1);

export function isDatabaseReadinessSatisfied(rows: unknown, expectedSessionRole: string) {
  const row = databaseReadinessRowsSchema.parse(rows).at(0);

  return (
    row?.ready === true &&
    row.currentRoleRestricted &&
    row.sessionMembershipRestricted &&
    row.sessionRestricted &&
    row.sessionRole === expectedSessionRole
  );
}
