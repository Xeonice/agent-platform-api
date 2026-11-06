// Isolated protocol fixture producer. Uses the real project JS signer and the
// actual passive reservation/command journal; no installer or Native is invoked.
import { readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  signQualificationManifest,
  runInputFingerprint,
  verifySignedManifest,
  digest,
  invariant,
} from '../../../deploy/upgrade/trust.mjs';
import { createControlAdoptionReservation } from '../../../deploy/upgrade/control-adoption-reservation.mjs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
if (input.action === 'sign') {
  const keys = generateKeyPairSync('ed25519'),
    manifest = input.manifest;
  manifest.purpose = 'qualification';
  manifest.evidence = manifest.evidence.map((gate) => ({
    ...gate,
    inputFingerprint: runInputFingerprint(manifest),
  }));
  manifest.qualification = {
    instanceId: input.instanceId,
    inputFingerprint: runInputFingerprint(manifest),
  };
  const envelope = signQualificationManifest(
    manifest,
    'isolated-control-attach',
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  );
  const roots = {
    schemaVersion: 1,
    purpose: 'qualification',
    qualificationInstanceId: input.instanceId,
    channel: manifest.channel,
    distributionOrigins: ['https://distribution.invalid'],
    keys: [
      {
        id: 'isolated-control-attach',
        publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
      },
    ],
  };
  writeFileSync(join(input.root, 'signed-target.json'), JSON.stringify(envelope), { mode: 0o600 });
  writeFileSync(join(input.root, 'trust.json'), JSON.stringify(roots), { mode: 0o600 });
  process.stdout.write(JSON.stringify(envelope));
} else if (input.action === 'reserve') {
  const Database = createRequire(new URL('../../package.json', import.meta.url))('better-sqlite3');
  const sqlite = new Database(input.spec.controlDatabase.path),
    original = new Database(input.businessPath, { readonly: true, fileMustExist: true });
  try {
    const fixed = json(join(input.root, 'signed-target.json')),
      roots = json(join(input.root, 'trust.json'));
    const reservation = createControlAdoptionReservation({
      sqlite,
      instanceId: input.spec.instanceId,
      epochFloor: 0,
      validateIntent(spec) {
        const trusted = verifySignedManifest(fixed, roots),
          frozen = original
            .prepare('SELECT receipt FROM upgrade_control_attachment WHERE instance_id=?')
            .get(spec.instanceId);
        invariant(
          frozen &&
            trusted.manifestDigest === spec.target.signedManifestDigest &&
            trusted.manifest.controlPackage.manifestDigest === spec.target.controlPackageDigest,
          'FIXTURE_TARGET_NOT_ACTUAL_SIGNED_MANIFEST',
        );
        const receipt = JSON.parse(frozen.receipt),
          { receiptDigest, ...facts } = receipt;
        invariant(
          digest(facts) === receiptDigest &&
            spec.freezeReceiptDigest === receiptDigest &&
            receipt.operationId === spec.operationId,
          'FIXTURE_ACTUAL_FREEZE_REQUIRED',
        );
        return {
          instanceId: spec.instanceId,
          operationId: spec.operationId,
          specDigest: digest(spec),
          freezeReceiptDigest: receiptDigest,
        };
      },
    });
    reservation.reserve(input.spec);
    const a = reservation.authorization(input.spec.operationId),
      common = { operationId: input.spec.operationId, authorization: a };
    const settlement = reservation.settlementSpec(input.spec.operationId);
    reservation.journal.prepare({
      ...common,
      commandId: settlement.commandId,
      stepId: 'isolated-legacy-settlement',
      spec: settlement,
    });
    reservation.journal.begin({ ...common, commandId: settlement.commandId });
    // Explicit external settlement proof port: no real Supervisor or process
    // custody is claimed by this SQLite/HTTP bottom-layer experiment.
    const facts = {
      schemaVersion: 1,
      kind: 'legacy-control-settlement',
      instanceId: input.spec.instanceId,
      operationId: input.spec.operationId,
      freezeReceiptDigest: input.spec.freezeReceiptDigest,
      sourceConfirmedDigest: input.spec.source.confirmedDigest,
      localAdmissionClosed: true,
      legacyCallersClosed: true,
      originalDispatchesSettled: true,
      qualified: true,
      observedAt: Date.now(),
    };
    const result = { ...facts, receiptDigest: digest(facts) };
    reservation.journal.record({
      ...common,
      commandId: settlement.commandId,
      state: 'applied',
      result,
    });
    reservation.journal.begin({ ...common, commandId: input.spec.commandId });
    process.stdout.write(
      JSON.stringify({ specDigest: digest(input.spec), settlementResultDigest: digest(result) }),
    );
  } finally {
    original.close();
    sqlite.close();
  }
} else throw Error('Unknown isolated producer action');
