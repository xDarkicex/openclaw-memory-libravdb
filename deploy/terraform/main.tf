# ── LibraVDB Daemon — Terraform Module ──
#
# Deploys the Helm chart to any k8s cluster.
# Provider examples: eks/, gke/, aks/ subdirectories.

terraform {
  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
  }
}

variable "namespace" {
  description = "Kubernetes namespace"
  type        = string
  default     = "libravdb"
}

variable "chart_version" {
  description = "Helm chart version to deploy"
  type        = string
  default     = ""
}

variable "values" {
  description = "Override values for the Helm chart"
  type        = list(object({
    name  = string
    value = string
  }))
  default = []
}

resource "kubernetes_namespace" "libravdb" {
  metadata {
    name = var.namespace
  }
}

resource "helm_release" "libravdbd" {
  name       = "libravdbd"
  repository = "https://xdarkicex.github.io/openclaw-memory-libravdb"
  chart      = "libravdbd"
  version    = var.chart_version
  namespace  = kubernetes_namespace.libravdb.metadata[0].name

  dynamic "set" {
    for_each = var.values
    content {
      name  = set.value.name
      value = set.value.value
    }
  }
}

output "namespace" {
  value = kubernetes_namespace.libravdb.metadata[0].name
}

output "release_name" {
  value = helm_release.libravdbd.name
}
