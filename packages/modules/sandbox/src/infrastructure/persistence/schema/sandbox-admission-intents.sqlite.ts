import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const sandboxAdmissionIntents = sqliteTable('sandbox_admission_intents', {
  sandboxId: text('sandbox_id').primaryKey(),
  input: text('input').notNull(),
  inputDigest: text('input_digest').notNull(),
});
