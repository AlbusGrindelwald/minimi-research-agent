CREATE TABLE IF NOT EXISTS provider_usage (
  provider TEXT NOT NULL,
  usage_month TEXT NOT NULL,
  credits_reserved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(provider, usage_month)
);
