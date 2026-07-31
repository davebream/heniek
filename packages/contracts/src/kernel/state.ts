import { Type, type Static, type TLiteral, type TUnion } from "@sinclair/typebox";

export interface StateVocabulary<Terminal extends string, NonTerminal extends string> {
  readonly schema: TUnion<TLiteral<Terminal | NonTerminal>[]>;
  readonly values: readonly (Terminal | NonTerminal)[];
  readonly terminal: ReadonlySet<Terminal | NonTerminal>;
  readonly nonTerminal: ReadonlySet<Terminal | NonTerminal>;
  isTerminal(value: Terminal | NonTerminal): boolean;
}

/**
 * Declares one state transition vocabulary with an explicit, exhaustive
 * terminal/non-terminal partition — every vocabulary in this package must
 * be able to answer "is this value terminal?" without external knowledge.
 */
export function defineStates<const Terminal extends string, const NonTerminal extends string>(config: {
  readonly terminal: readonly Terminal[];
  readonly nonTerminal: readonly NonTerminal[];
}): StateVocabulary<Terminal, NonTerminal> {
  const values = [...config.nonTerminal, ...config.terminal] as readonly (Terminal | NonTerminal)[];

  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate state value: ${value}`);
    }
    seen.add(value);
  }

  const terminal = new Set<Terminal | NonTerminal>(config.terminal);
  const nonTerminal = new Set<Terminal | NonTerminal>(config.nonTerminal);
  const schema = Type.Union(values.map((value) => Type.Literal(value))) as TUnion<
    TLiteral<Terminal | NonTerminal>[]
  >;

  return {
    schema,
    values,
    terminal,
    nonTerminal,
    isTerminal: (value) => terminal.has(value),
  };
}

export type StaticStates<S extends StateVocabulary<string, string>> = Static<S["schema"]>;
