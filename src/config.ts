export function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required");
  return value;
}

export function requiredJwtSecret(): string {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32 || value.includes("replace_this")) {
    throw new Error("JWT_SECRET must be set to a random secret of at least 32 characters");
  }
  return value;
}
