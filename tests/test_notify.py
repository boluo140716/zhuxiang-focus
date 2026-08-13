"""本地系统通知接口测试。"""


def test_send_toast_ok(client):
    """非 Windows / 无桌面环境时静默成功（winotify 导入失败被吞）。"""
    r = client.post("/api/notify/toast", json={"title": "篆香", "body": "一炷香已尽"})
    assert r.status_code == 200
    assert r.json() == {"ok": True}
