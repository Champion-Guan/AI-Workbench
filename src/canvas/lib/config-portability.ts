// A vault reference belongs to one installation, not to a portable config.
// Do not resolve it against another computer's registry or silently replace
// its credential with a default. Local recovery is a separate workflow.
export function assertPortableCredentialBindings(config: unknown, webdav: unknown) {
    const record = (value: unknown): Record<string, unknown> =>
        value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const root = record(config);
    const bindings = [root, ...(Array.isArray(root.channels) ? root.channels.map(record) : []), record(webdav)];
    for (const binding of bindings) {
        for (const key of ["apiKey", "password"]) {
            const value = binding[key];
            if (typeof value === "string" && /^guan-vault:/i.test(value.trim())) throw new Error("config_local_credential_reference");
        }
        for (const key of ["baseUrl", "url"]) {
            const value = binding[key];
            if (typeof value !== "string" || !value.trim()) continue;
            try {
                const path = new URL(value, "http://config.invalid").pathname;
                if (/\/(?:local-secure-api)(?:\/|$)/i.test(decodeURIComponent(path))) throw new Error("config_local_credential_reference");
            } catch (error) {
                if (error instanceof Error && error.message === "config_local_credential_reference") throw error;
                // General endpoint validation remains the config editor's job.
                // A malformed URL is not authority to resolve a vault account.
            }
        }
    }
}
