/** One reviewed additive global migration, shared by the schema-28 bridge and
 * schema-29 release. A signed package selects this identity; it supplies no SQL.
 * Journal/column digests come from the actual committed Drizzle migrations.
 */
export const IMAGE_RUNTIME_SCHEMA_PLAN = Object.freeze({
  schemaVersion: 1,
  kind: 'image-runtime-versions-additive',
  fromSchema: 28,
  targetSchema: 29,
  migrationTag: '0028_image_runtime_versions',
  migrationHash: '07ec75abf7d8a8a6bc709318363aef828b732fedba5ab4f09f2f1b9420fb6027',
  migrationTimestamp: 1792237069545,
  sourceJournalDigest: 'sha256:263f153b7b54cae58c464abfde96140212d4e0347462c8820fa1102a31de2c62',
  targetJournalDigest: 'sha256:b945ce667de71cd53b3f1dcda9ff4b8c667613986ba95c9940a7cbdfe0f3a3df',
  sourceColumnsDigest: 'sha256:ea13522c72af9a91675cacd5155115847f06999fc8c17b0095b6d157783896e6',
  targetColumnsDigest: 'sha256:e9fdd285b3cb39316ebfb0c549d72508b298d4bd6ec63c06ea86b3b9f4eb4914',
  oldRepresentationRetained: true,
  newSemanticsEnabled: false,
});
export const IMAGE_RUNTIME_SCHEMA_PLAN_DIGEST =
  'sha256:3e0d9d65f6974c2ce27a9acfee2795d603a6124bd951f3c53cbe02ef37543354';

/** All other global migrations remain refused, even under qualification trust. */
export function compatibleGlobalSchemaPath(
  path: {
    minSchema: number;
    maxSchema: number;
    targetSchema: number;
    migrationPlanDigest: string | null;
  },
  schema: number,
): boolean {
  return (
    path.targetSchema === schema ||
    (schema === 28 &&
      path.minSchema === 28 &&
      path.maxSchema === 29 &&
      path.targetSchema === 29 &&
      path.migrationPlanDigest === IMAGE_RUNTIME_SCHEMA_PLAN_DIGEST)
  );
}
