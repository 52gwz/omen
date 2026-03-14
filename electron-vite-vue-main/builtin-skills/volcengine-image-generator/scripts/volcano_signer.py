"""火山引擎视觉 API 签名工具

实现 HMAC-SHA256 签名机制，用于通用3.0和即梦系列模型的认证。
参考文档: https://www.volcengine.com/docs/6461/1277764
"""

import datetime
import hashlib
import hmac
import json
from urllib.parse import urlparse


class VolcSigner:

    SERVICE = "cv"
    REGION = "cn-north-1"
    ALGORITHM = "HMAC-SHA256"

    def __init__(self, access_key: str, secret_key: str):
        self.access_key = access_key
        self.secret_key = secret_key

    def sign(self, method: str, url: str, body: dict = None) -> dict:
        now = datetime.datetime.utcnow()
        date_stamp = now.strftime("%Y%m%d")
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")

        parsed = urlparse(url)
        host = parsed.hostname
        path = parsed.path or "/"
        query = parsed.query or ""

        payload = json.dumps(body) if body else ""
        payload_hash = hashlib.sha256(payload.encode("utf-8")).hexdigest()

        headers_to_sign = {
            "host": host,
            "x-date": amz_date,
            "x-content-sha256": payload_hash,
            "content-type": "application/json",
        }

        signed_header_keys = sorted(headers_to_sign.keys())
        signed_headers_str = ";".join(signed_header_keys)
        canonical_headers = "".join(
            f"{k}:{headers_to_sign[k]}\n" for k in signed_header_keys
        )

        canonical_request = "\n".join([
            method.upper(),
            path,
            query,
            canonical_headers,
            signed_headers_str,
            payload_hash,
        ])

        credential_scope = f"{date_stamp}/{self.REGION}/{self.SERVICE}/request"
        string_to_sign = "\n".join([
            self.ALGORITHM,
            amz_date,
            credential_scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ])

        signing_key = self._get_signing_key(date_stamp)
        signature = hmac.new(
            signing_key, string_to_sign.encode("utf-8"), hashlib.sha256
        ).hexdigest()

        authorization = (
            f"{self.ALGORITHM} "
            f"Credential={self.access_key}/{credential_scope}, "
            f"SignedHeaders={signed_headers_str}, "
            f"Signature={signature}"
        )

        return {
            "Content-Type": "application/json",
            "Host": host,
            "X-Date": amz_date,
            "X-Content-Sha256": payload_hash,
            "Authorization": authorization,
        }

    def _get_signing_key(self, date_stamp: str) -> bytes:
        k_date = self._hmac_sha256(self.secret_key.encode("utf-8"), date_stamp)
        k_region = self._hmac_sha256(k_date, self.REGION)
        k_service = self._hmac_sha256(k_region, self.SERVICE)
        k_signing = self._hmac_sha256(k_service, "request")
        return k_signing

    @staticmethod
    def _hmac_sha256(key: bytes, msg: str) -> bytes:
        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()
