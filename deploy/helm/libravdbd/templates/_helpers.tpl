{{- define "libravdbd.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "libravdbd.grpcPort" -}}
{{- $endpoint := .Values.config.grpcEndpoint | toString -}}
{{- if not (regexMatch "^tcp:.+:[0-9]+$" $endpoint) -}}
{{- fail "config.grpcEndpoint must be a TCP endpoint such as tcp:0.0.0.0:50051" -}}
{{- end -}}
{{- $port := regexFind "[0-9]+$" $endpoint | int -}}
{{- if or (lt $port 1) (gt $port 65535) -}}
{{- fail "config.grpcEndpoint port must be between 1 and 65535" -}}
{{- end -}}
{{- $port -}}
{{- end }}

{{- define "libravdbd.labels" -}}
app.kubernetes.io/name: {{ include "libravdbd.fullname" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "libravdbd.selectorLabels" -}}
app.kubernetes.io/name: {{ include "libravdbd.fullname" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
