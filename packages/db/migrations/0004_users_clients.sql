-- Brief section 5: clients, users, sessions, invites.

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  external_ref text,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL DEFAULT '',
  role text NOT NULL CHECK (role IN ('biller', 'lead', 'admin')),
  password_hash text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'invited')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE UNIQUE INDEX users_email_idx ON users (lower(email));

CREATE TABLE user_clients (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, client_id)
);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('biller', 'lead', 'admin')),
  token_hash text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz
);

-- documents.client_id and chunks.client_id reference clients now that it exists.
ALTER TABLE documents
  ADD CONSTRAINT documents_client_fk FOREIGN KEY (client_id) REFERENCES clients(id);
ALTER TABLE chunks
  ADD CONSTRAINT chunks_client_fk FOREIGN KEY (client_id) REFERENCES clients(id);
