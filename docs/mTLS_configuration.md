# mTLS Configuration

The plugin supports mutual TLS (mTLS) for gRPC connections to the Vector Service. In mTLS, both the client and the server present X.509 certificates, and each side verifies the other's certificate against a trusted CA. When the Vector Service is configured with a client CA, it will reject any client that does not present a valid certificate signed by that CA.

## When mTLS is required

The Vector Service operator enables mTLS by configuring a client CA on the service side. When this is enabled, the Vector Service requires every connecting client to present a certificate signed by that CA. If the plugin is configured to use TLS but does not present a client certificate, the TLS handshake will fail and the connection will be rejected.

The plugin cannot detect whether the daemon requires mTLS — it must be configured explicitly. If connections fail with a "client did not provide a certificate" error, the plugin likely needs a client certificate configured.

## Configuration fields

| Field | Type | When to use |
|---|---|---|
| `grpcEndpointTlsClientCert` | string (file path) | Path to a PEM-encoded X.509 client certificate. Required when the Vector Service requires a client certificate. |
| `grpcEndpointTlsClientKey` | string (file path) | Path to the PEM-encoded private key that corresponds to the certificate. Required when `grpcEndpointTlsClientCert` is set. |

Both fields must be set together or not at all. Setting one without the other will cause a configuration error at startup.

These fields only take effect when the connection uses TLS — that is, when `grpcEndpointTlsMode` is not `"insecure"` and the endpoint is not a loopback address or Unix socket. See [TLS configuration](./TLS_configuration.md) for the full TLS behavior reference.

## Certificate requirements

- **Format**: PEM-encoded X.509 certificate (-----BEGIN CERTIFICATE-----)
- **Chain order**: Leaf certificate must be first in the file; intermediate certificates may follow in the same file
- **Signing**: The certificate must be signed by the CA that the Vector Service operator configured as the client CA
- **Key types accepted**:
  - RSA (any key size)
  - ECDSA (P-256, P-384, P-521)
  - Ed25519
- **Key file format**: PEM-encoded private key (-----BEGIN PRIVATE KEY----- or -----BEGIN RSA PRIVATE KEY----- etc.)
- **Key/cert match**: The private key must correspond to the leaf certificate's public key
- **Revocation**: The Vector Service does not perform revocation checking. Expired certificates are rejected (`NotAfter` boundary). Revoked but unexpired certificates are not detected. Keep certificate lifetimes short.

## Example configuration

```json
{
  "grpcEndpoint": "tcp:libravdb.internal:9090",
  "grpcEndpointTlsCa": "/etc/certs/company-ca.pem",
  "grpcEndpointTlsClientCert": "/etc/certs/plugin-client.crt",
  "grpcEndpointTlsClientKey": "/etc/certs/plugin-client.key"
}
```

This example shows all four gRPC TLS fields configured together for a remote Vector Service that uses a private CA and requires mTLS.

## Generating a client certificate (quick reference)

The following example shows OpenSSL commands to generate a client key, create a CSR, and sign it with a private CA. This is for illustration only — operators may use cert-manager, Vault, step, or other PKI tooling instead.

**1. Create a client private key:**
```bash
openssl genpkey -algorithm ED25519 -out client.key
```

**2. Create a certificate signing request (CSR):**
```bash
openssl req -new -key client.key -out client.csr -subj "/CN=openclaw-plugin/O=LibraVDB"
```

**3. Sign the CSR with the private CA:**
```bash
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out client.crt -days 365
```

Replace `ca.crt` and `ca.key` with the CA certificate and key that the daemon operator provided.

## Error reference

| Error | Likely cause | Fix |
|---|---|---|
| `tls: client did not provide a certificate` | mTLS is required by the Vector Service, but no client certificate is configured in the plugin | Set `grpcEndpointTlsClientCert` and `grpcEndpointTlsClientKey` in the plugin config |
| `tls: failed to verify client certificate: x509: certificate signed by unknown authority` | The client certificate is not signed by the Vector Service's client CA | Obtain a certificate signed by the CA the Vector Service operator configured as the client CA |
| `LibraVDB: failed to load TLS client certificate from "...": ENOENT: no such file or directory` | The certificate file path does not exist or is not readable | Verify the path set in `grpcEndpointTlsClientCert` exists and has correct permissions |
| `LibraVDB: failed to load TLS client key from "...": ENOENT: no such file or directory` | The key file path does not exist or is not readable | Verify the path set in `grpcEndpointTlsClientKey` exists and has correct permissions |
| `LibraVDB: grpcEndpointTlsClientCert and grpcEndpointTlsClientKey must both be set or both be omitted` | Only one of the two fields is set | Set both fields or remove both from the configuration |
