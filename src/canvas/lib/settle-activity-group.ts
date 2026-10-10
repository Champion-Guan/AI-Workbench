// Promise.all rejects before its siblings finish. Task/lock boundaries must drain
// all started operations before returning an error or releasing exclusivity.
export async function settleActivityGroup<const T extends readonly unknown[]>(operations: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
    const results = await Promise.allSettled(operations);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as { -readonly [P in keyof T]: Awaited<T[P]> };
}
