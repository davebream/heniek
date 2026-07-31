declare const BrandTag: unique symbol;

/**
 * Nominal-typing helper. Attaches a phantom `Name` tag to `T` with no
 * runtime representation, so structurally identical values (e.g. two
 * opaque ID strings) stay compile-time distinct.
 */
export type Brand<T, Name extends string> = T & { readonly [BrandTag]: Name };
