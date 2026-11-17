-- Durable, owner-scoped confirmation intents for patient assistant actions.
-- The intent UUID is the application payment idempotency key for paid booking.

ALTER TABLE assistant_conversations
  ADD CONSTRAINT assistant_conversations_id_user_unique UNIQUE (id, user_id);

CREATE TABLE assistant_action_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  assistant_message_id UUID NOT NULL,
  action_type TEXT NOT NULL
    CHECK (action_type IN ('book', 'reschedule', 'cancel')),
  action_args JSONB NOT NULL
    CHECK (jsonb_typeof(action_args) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'executing', 'checkout_pending', 'refund_pending',
      'completed', 'failed', 'expired'
    )),
  expires_at TIMESTAMPTZ NOT NULL,
  execution_lease_until TIMESTAMPTZ,
  execution_lease_token UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT assistant_action_intents_owner_conversation_fk
    FOREIGN KEY (conversation_id, user_id)
    REFERENCES assistant_conversations (id, user_id) ON DELETE CASCADE,
  CONSTRAINT assistant_action_intents_message_conversation_fk
    FOREIGN KEY (assistant_message_id, conversation_id)
    REFERENCES assistant_messages (id, conversation_id) ON DELETE CASCADE,
  CONSTRAINT assistant_action_intents_lease_state_check
    CHECK (
      (
        status = 'executing'
        AND execution_lease_until IS NOT NULL
        AND execution_lease_token IS NOT NULL
      )
      OR (
        status IN ('checkout_pending', 'refund_pending')
        AND (execution_lease_until IS NULL) = (execution_lease_token IS NULL)
      )
      OR (
        status IN ('pending', 'completed', 'expired', 'failed')
        AND execution_lease_until IS NULL
        AND execution_lease_token IS NULL
      )
    )
);

CREATE INDEX assistant_action_intents_conversation_user_idx
  ON assistant_action_intents (conversation_id, user_id);

CREATE INDEX assistant_action_intents_message_conversation_idx
  ON assistant_action_intents (assistant_message_id, conversation_id);
