@id("allow-read-customer-data")
permit (
  principal,
  action in [Action::"read_customer", Action::"search_customers", Action::"read_tickets"],
  resource
);

@id("allow-readonly-sql")
permit (
  principal,
  action == Action::"run_sql",
  resource
) when {
  context.sqlOperation == "SELECT"
};

@id("allow-email")
permit (
  principal,
  action == Action::"send_email",
  resource
);

@id("allow-export")
permit (
  principal,
  action == Action::"export_customers",
  resource
);

@id("allow-small-refunds")
permit (
  principal,
  action == Action::"issue_refund",
  resource
) when {
  context.amountRupees <= 5000
};

@id("forbid-destructive-sql")
forbid (
  principal,
  action == Action::"run_sql",
  resource
) when {
  context.sqlOperation != "SELECT"
};

@id("forbid-bulk-export")
forbid (
  principal,
  action == Action::"export_customers",
  resource
) when {
  context.rowCount > 50
};

@id("forbid-email-to-untrusted-domain")
forbid (
  principal,
  action == Action::"send_email",
  resource
) when {
  context.trusted == false
};
