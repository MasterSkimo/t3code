# Harness Hub boundaries

Provider configuration remains authoritative. Hub discovery reads server-owned project and home directories and reports unknown states where provider semantics cannot be established. A native configuration is not evidence that an MCP connection is authenticated or usable.

The Harness proposal service owns decisions and audit history; the learning engine returns proposals and cannot distribute configurations or start authentication. Scope changes and supported MCP writes use server-resolved paths and explicit confirmation. The client never supplies a filesystem path. The MCP adapter refuses unsupported formats and avoids copying credentials; a successful write is reported independently of connection status.

Provider-native OAuth credentials stay with their provider. T3 does not currently coordinate external MCP OAuth callbacks or verify MCP connection status. Users must follow their provider's own authentication flow. Remote environments must authenticate on the machine and account that owns the provider configuration.

Filesystem fingerprints detect common external changes before a write, but external editors do not participate in the Hub's lock. A change between the final check and rename can still be overwritten. Provider configuration changes should therefore be reviewed before applying them.
