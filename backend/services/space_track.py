"""
Space-Track.org client for GP (TLE/OMM) data retrieval.

Implements session-based authentication and the recommended query:
  /basicspacedata/query/class/gp/decay_date/null-val/CREATION_DATE/>now-0.042/format/json

Rate limit: 1 request/hour for GP class.
"""

import logging
from typing import Optional

import requests

logger = logging.getLogger("space_track")

SPACE_TRACK_BASE = "https://www.space-track.org"
LOGIN_URL        = f"{SPACE_TRACK_BASE}/ajaxauth/login"
WHOAMI_URL       = f"{SPACE_TRACK_BASE}/app/data/whoami"

# Per Space-Track API guidelines (GP class, hourly retrieval):
#   decay_date/null-val        → exclude decayed/re-entered objects
#   CREATION_DATE/%3Enow-0.042 → only elements uploaded in the last ~60 min
#                                (0.042 days ≈ 1 hour; matches GP update cadence)
# epoch/%3Enow-10 is the slower one-time full-catalog variant; avoid for scripts.
GP_QUERY_URL = (
    f"{SPACE_TRACK_BASE}/basicspacedata/query/class/gp"
    "/decay_date/null-val"
    "/CREATION_DATE/%3Enow-0.042"
    "/format/json"
)


class SpaceTrackClient:
    def __init__(self, username: str, password: str):
        self.username = username
        self.password = password
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "OrbitSafe/1.0 (Space-Track API)",
            "Accept": "application/json",
        })
        self._logged_in = False

    def _login(self) -> bool:
        """
        Authenticate against Space-Track and verify the session.

        Space-Track always returns HTTP 200 on the login POST regardless of
        whether credentials are correct, so checking the status code is not
        sufficient.  The deprecated 'chocolatechip' cookie is no longer set.

        Instead, after the POST we send a lightweight GET to /app/data/whoami
        which returns {"logged_in": bool, "identity": str|null, ...}.
        This also extends the 2-hour session lifetime on each call.
        """
        if self._logged_in:
            return True
        try:
            resp = self.session.post(
                LOGIN_URL,
                data={"identity": self.username, "password": self.password},
                timeout=30,
            )
            resp.raise_for_status()

            # Verify authentication with a lightweight whoami query
            whoami_resp = self.session.get(WHOAMI_URL, timeout=15)
            whoami_resp.raise_for_status()
            whoami = whoami_resp.json()
            self._logged_in = bool(whoami.get("logged_in", False))

            if self._logged_in:
                logger.info("Space-Track authentication successful (identity: %s)",
                            whoami.get("identity"))
            else:
                logger.error("Space-Track login POST succeeded but whoami "
                             "reports logged_in=false — check credentials")
            return self._logged_in

        except Exception as exc:
            logger.error("Space-Track login failed: %s", exc)
            return False

    def fetch_gp_data(self) -> Optional[list[dict]]:
        """Fetch GP data in OMM JSON format. Returns None on failure."""
        if not self._login():
            return None

        try:
            resp = self.session.get(GP_QUERY_URL, timeout=60)
            if resp.status_code == 401:
                # Session expired, try re-auth once
                self._logged_in = False
                if self._login():
                    resp = self.session.get(GP_QUERY_URL, timeout=60)
            resp.raise_for_status()
            records = resp.json()
            logger.info("Fetched %d GP records from Space-Track", len(records))
            return records
        except requests.exceptions.HTTPError as exc:
            if exc.response is not None and exc.response.status_code == 429:
                logger.warning("Space-Track rate limit (429)")
            else:
                logger.error("Space-Track HTTP error: %s", exc)
            return None
        except Exception as exc:
            logger.error("Space-Track fetch failed: %s", exc)
            return None