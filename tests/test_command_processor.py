"""Tests for WebATM.proxy.managers.command_processor.CommandProcessor."""


class TestSendCommand:
    def test_returns_false_when_no_client(self, proxy):
        proxy.bluesky_client = None
        assert proxy.command_proc.send_command("CRE KL204") is False

    def test_returns_false_when_client_not_running(self, proxy, fake_client):
        fake_client.running = False
        proxy.bluesky_client = fake_client
        assert proxy.command_proc.send_command("CRE KL204") is False

    def test_forwards_non_local_command_to_server(self, proxy, fake_client):
        proxy.bluesky_client = fake_client
        assert proxy.command_proc.send_command("CRE KL204") is True
        topics = [topic for topic, _, _ in fake_client.sent]
        assert "STACK" in topics
        # forwarded to the server_id since no active node is set
        sent = fake_client.sent[0]
        assert sent[1] == "CRE KL204"
        assert sent[2] == fake_client.server_id

    def test_forwards_to_active_node_when_set(self, proxy, fake_client):
        fake_client.act_id = b"NODE\x81"
        proxy.bluesky_client = fake_client
        proxy.command_proc.send_command("HDG 90")
        assert fake_client.sent[0][2] == b"NODE\x81"

    def test_help_command_is_handled_locally(self, proxy, fake_client, fake_socketio):
        proxy.bluesky_client = fake_client
        proxy.command_proc.send_command("HELP")
        # HELP is local: nothing forwarded to the server...
        assert fake_client.sent == []
        # ...and an echo response is produced.
        assert fake_socketio.count("echo") == 1


class TestResolveTarget:
    def test_returns_explicit_target_id(self, proxy, fake_client):
        proxy.bluesky_client = fake_client
        assert proxy.command_proc._resolve_target(b"TARGET") == b"TARGET"

    def test_returns_active_node_when_set(self, proxy, fake_client):
        fake_client.act_id = b"NODE\x81"
        proxy.bluesky_client = fake_client
        assert proxy.command_proc._resolve_target() == b"NODE\x81"

    def test_falls_back_to_server_id(self, proxy, fake_client):
        fake_client.act_id = None
        proxy.bluesky_client = fake_client
        assert proxy.command_proc._resolve_target() == fake_client.server_id


class TestProcessStackCommands:
    def test_help_echo_uses_ok_flags(self, proxy, fake_client, fake_socketio):
        proxy.bluesky_client = fake_client
        proxy.command_proc.send_command("HELP")
        assert fake_socketio.last("echo")["flags"] == 0

    def test_blank_command_is_skipped(self, proxy, fake_client):
        proxy.bluesky_client = fake_client
        proxy.command_proc.send_command("   ")
        assert fake_client.sent == []


class TestForward:
    def test_no_cmdlines_is_noop(self, proxy, fake_client):
        proxy.bluesky_client = fake_client
        proxy.command_proc.forward()
        assert fake_client.sent == []

    def test_joins_multiple_commands_with_semicolons(self, proxy, fake_client):
        proxy.bluesky_client = fake_client
        proxy.command_proc.forward("CRE KL204", "HDG 90")
        assert fake_client.sent[0][1] == "CRE KL204;HDG 90"

    def test_uses_explicit_target_id(self, proxy, fake_client):
        proxy.bluesky_client = fake_client
        proxy.command_proc.forward("OP", target_id=b"TARGET")
        assert fake_client.sent[0][2] == b"TARGET"

    def test_falls_back_to_server_when_no_active_node(self, proxy, fake_client):
        fake_client.act_id = None
        proxy.bluesky_client = fake_client
        proxy.command_proc.forward("OP")
        assert fake_client.sent[0][2] == fake_client.server_id

    def test_no_send_when_client_not_running(self, proxy, fake_client):
        fake_client.running = False
        proxy.bluesky_client = fake_client
        proxy.command_proc.forward("OP")
        assert fake_client.sent == []


class TestExecuteLocalCommand:
    def test_help_without_argument(self, proxy):
        success, text = proxy.command_proc._execute_local_command("HELP", "")
        assert success is True
        assert "BlueSky Web Client" in text

    def test_help_with_argument(self, proxy):
        success, text = proxy.command_proc._execute_local_command("HELP", "CRE")
        assert success is True
        assert "CRE" in text

    def test_unknown_local_command(self, proxy):
        success, text = proxy.command_proc._execute_local_command("FOO", "")
        assert success is False
        assert "not implemented" in text


class TestEchoResponse:
    def test_stores_and_emits_echo(self, proxy, fake_socketio):
        proxy.command_proc._echo_response("hello", 0)
        assert proxy.echo_data["text"] == "hello"
        assert proxy.echo_data["flags"] == 0
        assert fake_socketio.count("echo") == 1

    def test_flags_coerced_to_int(self, proxy, fake_socketio):
        proxy.command_proc._echo_response("warn", "2")
        assert proxy.echo_data["flags"] == 2

    def test_no_emit_without_clients(self, proxy, fake_socketio):
        proxy.connected_clients = 0
        proxy.command_proc._echo_response("hi", 0)
        # Still stored, just not emitted.
        assert proxy.echo_data["text"] == "hi"
        assert fake_socketio.count("echo") == 0


class TestZoomCommand:
    def test_zoom_in_emits_event(self, proxy, fake_socketio):
        proxy.command_proc._handle_zoom_command("++")
        payload = fake_socketio.last("zoom")
        assert payload["direction"] == "in"
        assert payload["factor"] == 2

    def test_zoom_out_emits_event(self, proxy, fake_socketio):
        proxy.command_proc._handle_zoom_command("--")
        payload = fake_socketio.last("zoom")
        assert payload["direction"] == "out"
        assert payload["factor"] == 2
