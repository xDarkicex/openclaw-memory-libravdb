# TLS Configuration

In the default `"auto"` mode, Unix sockets and loopback addresses (localhost, 127.0.0.1, ::1) use plaintext, and other TCP addresses use TLS. Set `grpcEndpointTlsMode: "tls"` for a loopback TCP service that requires TLS. Unix sockets use plaintext even with this override. Configure a CA for a self-signed or private-CA service, and client credentials when the service requires mTLS.

## Default behavior

The plugin applies the following rules automatically:

| Endpoint type | Credential mode |
|---|---|
| Unix socket (`unix:/path/to/socket`) | Plaintext |
| Loopback (`tcp:127.0.0.1:port`, `tcp:localhost:port`, `[::1]:port`) | Plaintext |
| Any other TCP or DNS address | TLS |

These defaults select the transport; they do not detect the service's actual TLS configuration. Loopback connections are unencrypted, so local service access still needs an appropriate trust boundary.

## Configuration fields

| Field | Type | Default | When to use |
|---|---|---|---|
| `grpcEndpoint` | string | — | The vector service address. Set to a unix socket path, a loopback address, or a remote host. |
| `grpcEndpointTlsCa` | string | — | Path to a CA certificate PEM file. Required only when the vector service certificate is self-signed or signed by a private CA not in the system certificate store. |
| `grpcEndpointTlsMode` | `"auto"` \| `"tls"` \| `"insecure"` | `"auto"` | Override automatic TCP credential selection. `"tls"` forces TLS for TCP; `"insecure"` forces plaintext. Unix sockets always use plaintext. |

`grpcEndpointTlsMode` values explained:

- **`"auto"`** (default) — apply the automatic rules. Unix sockets and loopback use plaintext; all other addresses use TLS.
- **`"tls"`** — use TLS for TCP, including loopback addresses. Use this when the vector service has TLS enabled on a loopback address. Unix sockets remain plaintext.
- **`"insecure"`** — always use plaintext, even for remote addresses. Use this only when a service mesh or TLS-terminating tunnel handles encryption externally.

## Deployment scenarios

### Local vector service (default)

The vector service runs on the same machine, listening on a unix socket or a loopback address.

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

### Remote vector service with a trusted certificate

The vector service runs on a remote host and presents a certificate issued by a public CA such as Let's Encrypt. cert-manager can provision these certificates, but it can also use a private CA; trust depends on the configured issuer.

```json
{
  "grpcEndpoint": "tcp:libravdb.k8s.internal:9090"
}
```

TLS is automatic. The plugin uses Node's default trusted roots to verify the vector service's certificate, so no additional plugin configuration is needed when that issuer is trusted. A private cert-manager issuer requires `grpcEndpointTlsCa`.

### Remote vector service with a self-signed or private CA certificate

The vector service runs on a remote host and uses a self-signed certificate or a certificate signed by a private/internal CA not in the system certificate store.

```json
{
  "grpcEndpoint": "tcp:libravdb.internal:9090",
  "grpcEndpointTlsCa": "/etc/certs/company-ca.pem"
}
```

For a private CA, provide the CA certificate that signed the server certificate. For a self-signed server certificate, provide that certificate as the trust anchor. The plugin verifies the server certificate and the hostname or IP in the endpoint. Issue the server certificate with matching Subject Alternative Names; changing the CA does not fix a hostname mismatch.

### TLS on a loopback address

The vector service has TLS enabled on a loopback address. This is uncommon. The automatic rules would select plaintext for a loopback address, so an explicit override is required.

```json
{
  "grpcEndpoint": "tcp:127.0.0.1:9090",
  "grpcEndpointTlsMode": "tls"
}
```

Set `grpcEndpointTlsMode` to `"tls"` to force the plugin to use TLS even on the loopback address. The plugin will use the system certificate store for verification. If the vector service uses a self-signed certificate, add `grpcEndpointTlsCa` as well.

## Service mesh and tunnels

When the vector service runs behind Istio, Envoy, or any other infrastructure that terminates TLS at the mesh or tunnel layer, the plugin should not attempt its own TLS. Set `grpcEndpointTlsMode` to `"insecure"` so the plugin uses plaintext and lets the mesh handle encryption:

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
| `UNAVAILABLE / connection closed / TLS handshake failed` when connecting to a loopback address | The vector service has TLS enabled on a loopback address but the plugin is using plaintext (the default for loopback). | Add `"grpcEndpointTlsMode": "tls"` to the plugin config. |
| `x509: certificate signed by unknown authority` | The vector service uses a self-signed certificate or a certificate from a private CA not trusted by the system. | Set `grpcEndpointTlsCa` to the path of the CA certificate PEM file that signed the vector service's server certificate. |
| `failed to load TLS CA certificate from "...": ENOENT: no such file or directory` | The file path given in `grpcEndpointTlsCa` does not exist on the machine. | Verify the file path is correct and the CA certificate file exists. |
| `LibraVDB: invalid grpcEndpointTlsMode "..."` | The value set in `grpcEndpointTlsMode` is not one of the accepted values. | Change the value to `"auto"`, `"tls"`, or `"insecure"`. |
| `LIBRAVDB: grpcEndpointTlsCa is set but grpcEndpointTlsMode is "insecure"` (warning) | Both `grpcEndpointTlsCa` and `grpcEndpointTlsMode: "insecure"` are set. The CA file will not be used. | Remove `grpcEndpointTlsCa` if plaintext is intended, or change `grpcEndpointTlsMode` to `"auto"` or `"tls"` to use the CA file. |
