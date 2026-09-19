import type {
  InternalInferencePurpose,
  InternalInferenceStrategy,
} from "../contracts.ts";

export class InternalInferenceStrategyRegistry {
  private readonly strategies = new Map<string, InternalInferenceStrategy>();

  constructor(strategies: readonly InternalInferenceStrategy[] = []) {
    for (const strategy of strategies) this.register(strategy);
  }

  register(strategy: InternalInferenceStrategy): void {
    const key = strategyKey(strategy.purpose, strategy.strategyId, strategy.version);
    if (this.strategies.has(key)) throw new Error(`duplicate internal inference strategy: ${key}`);
    this.strategies.set(key, strategy);
  }

  get(
    purpose: InternalInferencePurpose,
    strategyId: string,
    version: number,
  ): InternalInferenceStrategy | undefined {
    return this.strategies.get(strategyKey(purpose, strategyId, version));
  }

  require(
    purpose: InternalInferencePurpose,
    strategyId: string,
    version: number,
  ): InternalInferenceStrategy {
    const strategy = this.get(purpose, strategyId, version);
    if (!strategy) {
      throw new Error(`unknown internal inference strategy: ${strategyKey(purpose, strategyId, version)}`);
    }
    return strategy;
  }
}

function strategyKey(purpose: InternalInferencePurpose, id: string, version: number): string {
  return `${purpose}:${id}@${version}`;
}
