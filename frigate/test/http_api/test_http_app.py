from unittest.mock import Mock, patch

import frigate.genai
from frigate.config import GenAIProviderEnum
from frigate.const import REDACTED_CREDENTIAL_SENTINEL
from frigate.genai import GenAIClient
from frigate.models import Event, Export, Previews, Recordings, ReviewSegment, Timeline
from frigate.stats.emitter import StatsEmitter
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp


class TestHttpApp(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Export, Previews, Recordings, ReviewSegment, Timeline])
        self.app = super().create_app()

    ####################################################################################################################
    ###################################  GET /stats Endpoint   #########################################################
    ####################################################################################################################
    def test_stats_endpoint(self):
        stats = Mock(spec=StatsEmitter)
        stats.get_latest_stats.return_value = self.test_stats
        app = super().create_app(stats)

        with AuthTestClient(app) as client:
            response = client.get("/stats")
            response_json = response.json()
            assert response_json == self.test_stats

    def test_recordings_storage_requires_admin(self):
        stats = Mock(spec=StatsEmitter)
        stats.get_latest_stats.return_value = self.test_stats
        app = super().create_app(stats)
        app.storage_maintainer = Mock()
        app.storage_maintainer.calculate_camera_usages.return_value = {
            "front_door": {"usage": 2.0},
        }

        with AuthTestClient(app) as client:
            response = client.get(
                "/recordings/storage",
                headers={"remote-user": "viewer", "remote-role": "viewer"},
            )
            assert response.status_code == 403

            response = client.get("/recordings/storage")
            assert response.status_code == 200
            assert response.json()["front_door"]["usage_percent"] == 25.0

    def test_orphaned_recordings_storage_and_merge(self):
        Recordings.create(
            id="orphan-recording",
            camera="old_front_door",
            path="/media/frigate/recordings/2026-01-01/00/old_front_door/segment.mp4",
            start_time=1,
            end_time=11,
            duration=10,
            motion=0,
            objects=0,
            segment_size=12.5,
        )
        Recordings.create(
            id="current-recording",
            camera="front_door",
            path="/media/frigate/recordings/2026-01-01/00/front_door/segment.mp4",
            start_time=1,
            end_time=11,
            duration=10,
            motion=0,
            objects=0,
            segment_size=4.0,
        )

        app = super().create_app()

        with AuthTestClient(app) as client:
            response = client.get("/recordings/storage/orphans")
            assert response.status_code == 200
            response_json = response.json()
            assert response_json["old_front_door"]["usage"] == 12.5
            assert response_json["old_front_door"]["recording_count"] == 1
            assert response_json["old_front_door"]["previews"][0]["path"] == (
                "recordings/2026-01-01/00/old_front_door/segment.mp4"
            )
            assert "front_door" not in response_json

            response = client.post(
                "/recordings/storage/orphans/old_front_door/merge",
                json={"target_camera": "front_door"},
            )
            assert response.status_code == 200
            assert response.json()["recordings"] == 1
            assert (
                Recordings.select()
                .where(Recordings.id == "orphan-recording")
                .get()
                .camera
                == "front_door"
            )

            response = client.get("/recordings/storage/orphans")
            assert response.status_code == 200
            assert response.json() == {}

    def test_config_set_in_memory_replaces_objects_track_list(self):
        self.minimal_config["cameras"]["front_door"]["objects"] = {
            "track": ["person", "car"],
        }
        app = super().create_app()
        app.config_publisher = Mock()

        with AuthTestClient(app) as client:
            response = client.put(
                "/config/set",
                json={
                    "requires_restart": 0,
                    "skip_save": True,
                    "update_topic": "config/cameras/front_door/objects",
                    "config_data": {
                        "cameras": {
                            "front_door": {
                                "objects": {
                                    "track": ["person"],
                                }
                            }
                        }
                    },
                },
            )

            assert response.status_code == 200
            assert app.frigate_config.cameras["front_door"].objects.track == ["person"]

    ####################################################################################################################
    ###################################  Credential redaction sentinel  ################################################
    ####################################################################################################################
    def test_config_response_redacts_mqtt_password_with_sentinel(self):
        self.minimal_config["mqtt"]["user"] = "mqttuser"
        self.minimal_config["mqtt"]["password"] = "supersecret"
        app = super().create_app()

        with AuthTestClient(app) as client:
            response = client.get("/config")
            assert response.status_code == 200
            mqtt = response.json()["mqtt"]
            assert mqtt["password"] == REDACTED_CREDENTIAL_SENTINEL

    ####################################################################################################################
    ###################################  POST /genai/probe Endpoint   ##################################################
    ####################################################################################################################
    def test_genai_probe_requires_admin(self):
        app = super().create_app()

        with AuthTestClient(app) as client:
            response = client.post(
                "/genai/probe",
                json={"provider": "openai"},
                headers={"remote-user": "viewer", "remote-role": "viewer"},
            )
            assert response.status_code == 403

    def test_genai_probe_returns_models_from_transient_client(self):
        class FakeClient(GenAIClient):
            def list_models(self):
                return ["fake-model-a", "fake-model-b"]

        app = super().create_app()

        with (
            AuthTestClient(app) as client,
            patch.dict(
                frigate.genai.PROVIDERS,
                {GenAIProviderEnum.openai: FakeClient},
            ),
        ):
            response = client.post(
                "/genai/probe",
                json={
                    "provider": "openai",
                    "api_key": "sk-test",
                    "base_url": "https://example.invalid",
                },
            )
            assert response.status_code == 200
            assert response.json() == {
                "success": True,
                "models": ["fake-model-a", "fake-model-b"],
            }

    def test_genai_probe_empty_list_is_treated_as_failure(self):
        # The plugin's list_models() returns [] on connection failure rather
        # than raising. The endpoint should surface that as success=false so
        # the UI can show a meaningful error.
        class EmptyClient(GenAIClient):
            def list_models(self):
                return []

        app = super().create_app()

        with (
            AuthTestClient(app) as client,
            patch.dict(
                frigate.genai.PROVIDERS,
                {GenAIProviderEnum.openai: EmptyClient},
            ),
        ):
            response = client.post(
                "/genai/probe",
                json={"provider": "openai"},
            )
            assert response.status_code == 200
            payload = response.json()
            assert payload["success"] is False
            assert "message" in payload

    def test_genai_probe_handles_provider_failure(self):
        class FailingClient(GenAIClient):
            def list_models(self):
                raise RuntimeError("provider unreachable")

        app = super().create_app()

        with (
            AuthTestClient(app) as client,
            patch.dict(
                frigate.genai.PROVIDERS,
                {GenAIProviderEnum.openai: FailingClient},
            ),
        ):
            response = client.post(
                "/genai/probe",
                json={"provider": "openai"},
            )
            assert response.status_code == 200
            payload = response.json()
            assert payload["success"] is False
            assert "message" in payload
