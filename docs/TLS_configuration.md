# TLS Configuration

The plugin selects the right credentials automatically based on which address it connects to. Unix sockets and loopback addresses (localhost, 127.0.0.1, ::1) always use plaintext. All other addresses use TLS. In most deployments no TLS configuration is needed at all. The only time manual configuration is required is when the daemon serves TLS on a loopback address, when the daemon uses a self-signed or private-CA certificate, or when infrastructure such as a service mesh handles TLS outside the plugin.

## Default behavior

The plugin applies the following rules automatically:

| Endpoint type | Credential mode |
|---|---|
| Unix socket (`unix:/path/to/socket`) | Plaintext |
| Loopback (`tcp:127.0.0.1:port`, `tcp:localhost:port`, `[::1]:port`) | Plaintext |
| Any other TCP or DNS address | TLS |

Because these rules are automatic, most users do not set any TLS-related fields. Plaintext is used where it is safe (local transport) and TLS is used where it is needed (network transport).

## Configuration fields

| Field | Type | Default | When to use |
|---|---|---|---|
| `grpcEndpoint` | string | — | The daemon address. Set to a unix socket path, a loopback address, or a remote host. |
| `grpcEndpointTlsCa` | string | — | Path to a CA certificate PEM file. Required only when the daemon certificate is self-signed or signed by a private CA not in the system certificate store. |
| `grpcEndpointTlsMode` | `"auto"` \| `"tls"` \| `"insecure"` | `"auto"` | Override the automatic selection. `"auto"` applies the default rules above. `"tls"` forces TLS regardless of address. `"insecure"` forces plaintext regardless of address. |

`grpcEndpointTlsMode` values explained:

- **`"auto"`** (default) — apply the automatic rules. Unix sockets and loopback use plaintext; all other addresses use TLS.
- **`"tls"`** — always use TLS, even for loopback addresses. Use this when the daemon has TLS enabled on a loopback address.
- **`"insecure"`** — always use plaintext, even for remote addresses. Use this only when a service mesh or TLS-terminating tunnel handles encryption externally.

## Deployment scenarios

### Local daemon (default)

The daemon runs on the same machine, listening on a unix socket or a loopback address.

```json
{
  "grpcEndpoint": "unix:/home/user/.libravdbd/run/libravdb.sock"
}
```

or:

```json
{
  "grpcEndpoint": "tcp:127.0.0.1:9090"
}
```

The plugin automatically uses plaintext. No TLS fields are needed.

### Remote daemon with a trusted certificate

The daemon runs on a remote host and presents a certificate issued by a public CA such as Let's Encrypt or cert-manager.

```json
{
  "grpcEndpoint": "tcp:libravdb.k8s.internal:9090"
}
```

TLS is automatic. The plugin uses the system certificate store to verify the daemon's certificate, so no additional configuration is needed.

### Remote daemon with a self-signed or private CA certificate

The daemon runs on a remote host and uses a self-signed certificate or a certificate signed by a private/internal CA not in the system certificate store.

```json
{
  "grpcEndpoint": "tcp:libravdb.internal:9090",
  "grpcEndpointTlsCa": "/etc/certs/company-ca.pem"
}
```

The CA certificate must be the certificate of the CA that signed the daemon's server certificate — not the server certificate itself. The plugin uses this CA to verify the daemon's certificate during the TLS handshake. Without it, the plugin will reject the daemon's certificate as untrusted.

### TLS on a loopback address

The daemon has TLS enabled on a loopback address. This is uncommon. The automatic rules would select plaintext for a loopback address, so an explicit override is required.

```json
{
  "grpcEndpoint": "tcp:127.0.0.1:9090",
  "grpcEndpointTlsMode": "tls"
}
```

Set `grpcEndpointTlsMode` to `"tls"` to force the plugin to use TLS even on the loopback address. The plugin will use the system certificate store for verification. If the daemon uses a self-signed certificate, add `grpcEndpointTlsCa` as well.

## Service mesh and tunnels

When the daemon runs behind Istio, Envoy, or any other infrastructure that terminates TLS at the mesh or tunnel layer, the plugin should not attempt its own TLS. Set `grpcEndpointTlsMode` to `"insecure"` so the plugin uses plaintext and lets the mesh handle encryption:

```json
{
  "grpcEndpoint": "tcp:libravdb.mesh.svc:9090",
  "grpcEndpointTlsMode": "insecure"
}
```

This applies even for remote addresses. The mesh terminates TLS at the boundary, and the plugin communicates with the mesh over plaintext on the inside.

## Error reference

| Error | Likely cause | Fix |
|---|---|---|
| `UNAVAILABLE / connection closed / TLS handshake failed` when connecting to a loopback address | The daemon has TLS enabled on a loopback address but the plugin is using plaintext (the default for loopback). | Add `"grpcEndpointTlsMode": "tls"` to the plugin config. |
| `x509: certificate signed by unknown authority` | The daemon uses a self-signed certificate or a certificate from a private CA not trusted by the system. | Set `grpcEndpointTlsCa` to the path of the CA certificate PEM file that signed the daemon's server certificate. |
| `failed to load TLS CA certificate from "...": ENOENT: no such file or directory` | The file path given in `grpcEndpointTlsCa` does not exist on the machine. | Verify the file path is correct and the CA certificate file exists. |
| `LibraVDB: invalid grpcEndpointTlsMode "..."` | The value set in `grpcEndpointTlsMode` is not one of the accepted values. | Change the value to `"auto"`, `"tls"`, or `"insecure"`. |
| `LIBRAVDB: grpcEndpointTlsCa is set but grpcEndpointTlsMode is "insecure"` (warning) | Both `grpcEndpointTlsCa` and `grpcEndpointTlsMode: "insecure"` are set. The CA file will not be used. | Remove `grpcEndpointTlsCa` if plaintext is intended, or change `grpcEndpointTlsMode` to `"auto"` or `"tls"` to use the CA file. |
