import { describe, expect, it } from 'vitest';
import { freezeUpgradeChain } from '../../../apps/api/src/platform/upgrade/upgrade-chain';
import { verifyUpgradeEnvelope } from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import {
  planFixtureAt,
  planFixtureEnvelope,
  planFixtureRoots,
  planFixtureSource,
} from '../../support/upgrade-plan-fixture';

describe('fixed signed compatibility chain planning', () => {
  it('selects the explicit bridge then final, preserving exact digests and projected sources', () => {
    const source = planFixtureSource(),
      bridge = planFixtureEnvelope(source, '0.2.1');
    const final = planFixtureEnvelope(
      {
        ...source,
        releaseId: '0.2.1',
        activationGeneration: 2,
        components: bridge.manifest.components,
      },
      '0.2.2',
      ['0.2.1'],
    );
    const trusted = [bridge, final].map((envelope) =>
      verifyUpgradeEnvelope(envelope, planFixtureRoots(), Date.parse(planFixtureAt)),
    );
    const chain = freezeUpgradeChain(trusted[1], source, trusted);
    expect(chain.map((stage) => stage.envelope.manifestDigest)).toEqual([
      bridge.manifestDigest,
      final.manifestDigest,
    ]);
    expect(chain.map((stage) => stage.plan.sourceActivationGeneration)).toEqual([1, 2]);
    expect(source.releaseId).toBe('0.2.0');
  });
  it('refuses missing bridges, cycles, conflicting release digests and incompatible protocols', () => {
    const source = planFixtureSource(),
      bridge = planFixtureEnvelope(source, '0.2.1');
    const final = planFixtureEnvelope({ ...source, releaseId: '0.2.1' }, '0.2.2', ['0.2.1']);
    expect(() => freezeUpgradeChain(final, source, [final])).toThrow('REQUIRED_BRIDGE_UNAVAILABLE');
    const cycle = planFixtureEnvelope({ ...source, releaseId: '0.2.2' }, '0.2.1');
    expect(() => freezeUpgradeChain(final, source, [cycle, final])).toThrow('UPGRADE_CHAIN_CYCLE');
    expect(() =>
      freezeUpgradeChain(final, source, [
        bridge,
        { ...bridge, manifestDigest: 'sha256:' + 'f'.repeat(64) },
        final,
      ]),
    ).toThrow('AMBIGUOUS_BRIDGE_RELEASE');
    const incompatible = structuredClone(bridge);
    incompatible.manifest.components.api.protocol = { min: 9, max: 10 };
    expect(() => freezeUpgradeChain(final, source, [incompatible, final])).toThrow(
      'INCOMPATIBLE_PROTOCOL',
    );
  });
});
