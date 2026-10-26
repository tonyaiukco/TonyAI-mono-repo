output "reviewed_inputs" {
  description = "Public inputs only; the independent body oracle never trusts a Terraform body output."
  value       = { foundation = var.foundation, release = var.release }
}
