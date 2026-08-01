{{- define "libravdbd.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
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
