# ── GCP GKE deployment ──

provider "google" {
  project = var.project
  region  = var.region
}

data "google_client_config" "default" {}

data "google_container_cluster" "cluster" {
  name     = var.cluster_name
  location = var.region
}

provider "kubernetes" {
  host  = "https://${data.google_container_cluster.cluster.endpoint}"
  token = data.google_client_config.default.access_token
  cluster_ca_certificate = base64decode(
    data.google_container_cluster.cluster.master_auth[0].cluster_ca_certificate
  )
}

provider "helm" {
  kubernetes {
    host  = "https://${data.google_container_cluster.cluster.endpoint}"
    token = data.google_client_config.default.access_token
    cluster_ca_certificate = base64decode(
      data.google_container_cluster.cluster.master_auth[0].cluster_ca_certificate
    )
  }
}

variable "project" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "cluster_name" {
  description = "GKE cluster name"
  type        = string
}

module "libravdbd" {
  source = "../"

  values = [
    { name  = "persistence.storageClass", value = "standard-rwo" },
  ]
}
