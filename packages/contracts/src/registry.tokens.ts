/**
 * DI token registry keys (docs/backend/01 platform/registry, 04 §8).
 * Three extension-point registries; concrete providers/adapters/specs register
 * against these tokens and application code depends only on the registry, not
 * on the concrete implementations (boundaries lint enforces this).
 */
export const SANDBOX_PROVIDER_REGISTRY = Symbol('SandboxProviderRegistry');
export const RUNTIME_ADAPTER_REGISTRY = Symbol('RuntimeAdapterRegistry');
export const IMAGE_SPEC_REGISTRY = Symbol('ImageSpecRegistry');
