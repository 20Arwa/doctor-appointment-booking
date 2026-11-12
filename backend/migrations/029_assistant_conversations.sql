CREATE TABLE assistant_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX assistant_conversations_user_updated_idx
  ON assistant_conversations (user_id, updated_at DESC, id DESC);

CREATE TABLE assistant_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  request_id UUID,
  request_status TEXT CHECK (request_status IN ('processing', 'complete', 'failed')),
  reply_to_message_id UUID,
  tool_results JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tool_results) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT assistant_messages_role_state CHECK (
    (role = 'user' AND request_id IS NOT NULL AND request_status IS NOT NULL AND reply_to_message_id IS NULL AND tool_results = '[]'::jsonb)
    OR (role = 'assistant' AND request_id IS NULL AND request_status IS NULL AND reply_to_message_id IS NOT NULL)
  ),
  CONSTRAINT assistant_messages_id_conversation_unique UNIQUE (id, conversation_id),
  CONSTRAINT assistant_messages_reply_same_conversation_fk
    FOREIGN KEY (reply_to_message_id, conversation_id)
    REFERENCES assistant_messages(id, conversation_id) ON DELETE CASCADE
);

CREATE FUNCTION enforce_assistant_reply_targets_user_message()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'Assistant message roles cannot be changed'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.role = 'assistant' AND NOT EXISTS (
    SELECT 1
    FROM assistant_messages referenced
    WHERE referenced.id = NEW.reply_to_message_id
      AND referenced.conversation_id = NEW.conversation_id
      AND referenced.role = 'user'
  ) THEN
    RAISE EXCEPTION 'Assistant replies must reference a user message in the same conversation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assistant_messages_reply_user_guard
  BEFORE INSERT OR UPDATE OF role, conversation_id, reply_to_message_id
  ON assistant_messages
  FOR EACH ROW
  EXECUTE FUNCTION enforce_assistant_reply_targets_user_message();

CREATE UNIQUE INDEX assistant_messages_request_unique
  ON assistant_messages (conversation_id, request_id)
  WHERE role = 'user';

CREATE UNIQUE INDEX assistant_messages_reply_unique
  ON assistant_messages (reply_to_message_id)
  WHERE role = 'assistant';

CREATE INDEX assistant_messages_conversation_created_idx
  ON assistant_messages (conversation_id, created_at DESC, id DESC);
