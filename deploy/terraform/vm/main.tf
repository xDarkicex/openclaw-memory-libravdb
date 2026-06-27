# ── Standalone VM deployment (AWS EC2) ──
# Runs libravdbd via Docker on a single compute instance.
# Minimal — just an EC2 instance with Docker and the daemon container.

provider "aws" {
  region = var.region
}

variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.medium"
}

variable "ssh_public_key" {
  description = "Path to SSH public key"
  type        = string
  default     = "~/.ssh/id_rsa.pub"
}

data "aws_ami" "ubuntu" {
  most_recent = true
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-noble-24.04-amd64-server-*"]
  }
  owners = ["099720109477"] # Canonical
}

data "aws_vpc" "default" {
  default = true
}

resource "aws_security_group" "libravdbd" {
  name        = "libravdbd-sg"
  description = "LibraVDB daemon"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port   = 50051
    to_port     = 50051
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
    description = "gRPC"
  }

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "SSH"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_key_pair" "libravdbd" {
  key_name   = "libravdbd-key"
  public_key = file(var.ssh_public_key)
}

resource "aws_instance" "libravdbd" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = aws_key_pair.libravdbd.key_name
  vpc_security_group_ids = [aws_security_group.libravdbd.id]

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
  }

  user_data = <<-EOF
    #!/bin/bash
    apt-get update && apt-get install -y docker.io
    systemctl enable --now docker

    mkdir -p /var/lib/libravdbd/data /var/lib/libravdbd/models

    docker run -d --restart=unless-stopped \
      --name libravdbd \
      -p 50051:50051 \
      -v /var/lib/libravdbd/data:/var/lib/libravdbd/data \
      -v /var/lib/libravdbd/models:/var/lib/libravdbd/models \
      -e LIBRAVDB_GRPC_ENDPOINT=tcp:0.0.0.0:50051 \
      -e LIBRAVDB_DB_PATH=/var/lib/libravdbd/data/data.libravdb \
      -e LIBRAVDB_EMBEDDING_BACKEND=gguf \
      ghcr.io/xdarkicex/libravdbd:latest
  EOF

  tags = {
    Name = "libravdbd"
  }
}

output "public_ip" {
  value = aws_instance.libravdbd.public_ip
}

output "grpc_endpoint" {
  value = "tcp:${aws_instance.libravdbd.public_ip}:50051"
}
