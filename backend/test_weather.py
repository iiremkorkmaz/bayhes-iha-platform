import json
import socket
import unittest
from decimal import Decimal
from unittest.mock import patch
from urllib.error import URLError

import main
from fastapi import HTTPException


class FakeResponse:
    def __init__(self, payload, headers=None):
        self.body = json.dumps(payload).encode("utf-8")
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


class MetNorwayProxyTests(unittest.TestCase):
    def setUp(self):
        main._met_norway_cache.clear()
        main._met_norway_request_times.clear()

    @staticmethod
    def forecast_payload():
        return {"properties": {"timeseries": [{"time": "2026-10-15T22:00:00Z"}]}}

    def test_request_identifies_application_truncates_coordinates_and_caches(self):
        response = FakeResponse(self.forecast_payload(), {"Cache-Control": "max-age=60", "Last-Modified": "Thu, 15 Oct 2026 19:18:04 GMT"})
        with patch("main.urlopen", return_value=response) as urlopen:
            result = main.fetch_met_norway(Decimal("36.6439"), Decimal("33.4384"))
            cached = main.fetch_met_norway(Decimal("36.6439"), Decimal("33.4384"))

        self.assertEqual(urlopen.call_count, 1)
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, f"{main.MET_NORWAY_URL}?lat=36.6439&lon=33.4384")
        self.assertIn("BAYHES-Risk", request.get_header("User-agent"))
        self.assertEqual(result["provider"], "MET Norway")
        self.assertEqual(cached["retrievedAt"], result["retrievedAt"])

    def test_timeout_is_reported_as_gateway_timeout(self):
        with patch("main.urlopen", side_effect=URLError(socket.timeout("timed out"))):
            with self.assertRaises(HTTPException) as raised:
                main.fetch_met_norway(Decimal("36.6439"), Decimal("33.4384"))
        self.assertEqual(raised.exception.status_code, 504)

    def test_invalid_json_is_not_cached_or_returned_as_weather(self):
        response = FakeResponse({"not": "forecast"})
        response.body = b"not-json"
        with patch("main.urlopen", return_value=response):
            with self.assertRaises(HTTPException) as raised:
                main.fetch_met_norway(Decimal("36.6439"), Decimal("33.4384"))
        self.assertEqual(raised.exception.status_code, 502)

    def test_cache_expiry_respects_age_and_no_cache_directives(self):
        self.assertEqual(main._cache_expiry({"Cache-Control": "max-age=60", "Age": "15"}, 100), 145)
        self.assertEqual(main._cache_expiry({"Cache-Control": "no-cache, max-age=60"}, 100), 100)

    def test_local_rate_limit_stays_below_the_documented_special_agreement_threshold(self):
        with patch("main.time.monotonic", return_value=100):
            for _ in range(19):
                main._reserve_met_norway_request()
            with self.assertRaises(HTTPException) as raised:
                main._reserve_met_norway_request()
        self.assertEqual(raised.exception.status_code, 429)


if __name__ == "__main__":
    unittest.main()
