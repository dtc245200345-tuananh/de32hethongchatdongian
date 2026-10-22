
BEGIN;
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    room VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_room_created_at
ON messages (room, created_at);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS username VARCHAR(50);

CREATE TABLE IF NOT EXISTS rooms (
    name VARCHAR(100) PRIMARY KEY,
    owner_id BIGINT REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS room_members (
    room VARCHAR(100) REFERENCES rooms(name),
    user_id BIGINT REFERENCES users(id),
    PRIMARY KEY (room, user_id)
);
-- Preserve existing messages; legacy rooms become authenticated public rooms.
INSERT INTO rooms(name) SELECT DISTINCT room FROM messages ON CONFLICT DO NOTHING;
COMMIT;

