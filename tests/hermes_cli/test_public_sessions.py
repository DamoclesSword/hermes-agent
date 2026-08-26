from hermes_cli.public_sessions import project_public_session, routed_profile_from_row


def test_malformed_and_incomplete_keys_do_not_claim_a_namespace():
    for session_key in (
        "agent:",
        "agent:juno",
        "agent:bad profile:photon:dm:x",
        "agent:Juno:photon:dm:x",
        "agent:juno.prod:photon:dm:x",
        "",
        "not-a-key",
    ):
        assert routed_profile_from_row({"session_key": session_key}) is None


def test_valid_key_and_origin_json_profile_are_used():
    assert routed_profile_from_row({"session_key": "agent:juno:photon:dm:peer"}) == "juno"
    assert routed_profile_from_row({"origin_json": '{"profile": "astra"}'}) == "astra"


def test_public_projection_scrubs_phone_labels_and_private_routing_fields():
    row = {
        "session_key": "agent:juno:photon:dm:opaque",
        "origin_json": '{"profile":"juno","chat_id":"opaque"}',
        "chat_id": "opaque",
        "user_id": "opaque",
        "thread_id": "opaque-thread",
        "space_id": "opaque-space",
        "display_name": "+15551234567",
        "title": "+15551234567",
    }
    project_public_session(row, "astra")
    assert row["routed_profile"] == "juno"
    assert row["is_profile_foreign"] is True
    assert row["display_name"] is None
    assert row["title"] is None
    assert "session_key" not in row
    assert "origin_json" not in row


def test_public_projection_scrubs_embedded_e164_transport_label():
    row = {
        "id": "session-1",
        "display_name": "any;-;+15551234567",
        "title": "ordinary title",
    }

    project_public_session(row, "lyra")

    assert row["display_name"] is None
    assert row["title"] == "ordinary title"
    assert "chat_id" not in row
    assert "user_id" not in row
    assert "thread_id" not in row
    assert "space_id" not in row
