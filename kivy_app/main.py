from kivy.app import App
from kivy.clock import Clock
from kivy.lang import Builder
from kivy.logger import Logger
from urllib.parse import quote

try:
    from android.permissions import Permission, request_permissions

    IS_ANDROID = True
except ImportError:
    IS_ANDROID = False
    Permission = None
    request_permissions = None


KV = """
Widget:
"""


class MainApp(App):
    SERVER_URL = "https://pedropnc.squareweb.app"
    ROOM_ID = "sala1"

    def build(self):
        self._transmitter_started = False
        self._request_in_progress = False
        return Builder.load_string(KV)

    def on_start(self):
        # Delay curto para garantir que a Activity esteja pronta.
        Clock.schedule_once(lambda *_: self.solicitar_e_abrir(), 0.3)

    def solicitar_e_abrir(self):
        if IS_ANDROID:
            if self._request_in_progress:
                return
            perms = [Permission.CAMERA, Permission.RECORD_AUDIO, Permission.INTERNET]
            self._request_in_progress = True
            request_permissions(perms, self._on_permission_result)

    def _on_permission_result(self, permissions, grants):
        _ = permissions
        self._request_in_progress = False
        if all(grants):
            if not self._transmitter_started:
                self._transmitter_started = True
                self._start_internal_transmitter()
            return

        self._show_terms_warning()
        # Continua solicitando permissao ate aceitar camera e microfone.
        Clock.schedule_once(lambda *_: self.solicitar_e_abrir(), 0.8)

    def _show_terms_warning(self):
        if not IS_ANDROID:
            return
        try:
            from jnius import autoclass

            PythonActivity = autoclass("org.kivy.android.PythonActivity")
            Toast = autoclass("android.widget.Toast")
            String = autoclass("java.lang.String")

            activity = PythonActivity.mActivity
            message = String(
                "Nao e permitido usar o app sem aceitar camera e audio. Isso faz parte dos termos de uso."
            )
            toast = Toast.makeText(activity, message, Toast.LENGTH_LONG)
            toast.show()
        except Exception as exc:
            Logger.warning(f"Main: falha ao exibir aviso de termos: {exc}")

    def _transmitter_url(self) -> str:
        base = self.SERVER_URL.strip().rstrip("/")
        room = quote(self.ROOM_ID.strip() or "sala1")
        return f"{base}/static/mobile_broadcaster.html?room={room}"

    def _start_internal_transmitter(self):
        if not IS_ANDROID:
            Logger.info("Main: transmissor interno ativo apenas no Android.")
            return

        try:
            from jnius import PythonJavaClass, autoclass, java_method

            PythonActivity = autoclass("org.kivy.android.PythonActivity")
            WebView = autoclass("android.webkit.WebView")
            WebViewClient = autoclass("android.webkit.WebViewClient")
            WebChromeClient = autoclass("android.webkit.WebChromeClient")
            Color = autoclass("android.graphics.Color")

            class WebViewRunnable(PythonJavaClass):
                __javainterfaces__ = ["java/lang/Runnable"]
                __javacontext__ = "app"

                def __init__(self, activity, url):
                    super().__init__()
                    self.activity = activity
                    self.url = url

                @java_method("()V")
                def run(self):
                    webview = WebView(self.activity)
                    settings = webview.getSettings()
                    settings.setJavaScriptEnabled(True)
                    settings.setDomStorageEnabled(True)
                    settings.setMediaPlaybackRequiresUserGesture(False)

                    class PermissionAwareWebChromeClient(PythonJavaClass):
                        __javabase__ = "android/webkit/WebChromeClient"
                        __javacontext__ = "app"

                        @java_method("(Landroid/webkit/PermissionRequest;)V")
                        def onPermissionRequest(self, request):
                            try:
                                request.grant(request.getResources())
                            except Exception as exc:
                                Logger.warning(f"Main: falha ao conceder permissao WebRTC no WebView: {exc}")

                    self._web_chrome_client = PermissionAwareWebChromeClient()

                    webview.setBackgroundColor(Color.BLACK)
                    webview.setWebViewClient(WebViewClient())
                    webview.setWebChromeClient(self._web_chrome_client)
                    webview.loadUrl(self.url)
                    self.activity.setContentView(webview)

            activity = PythonActivity.mActivity
            self._webview_runnable = WebViewRunnable(activity, self._transmitter_url())
            activity.runOnUiThread(self._webview_runnable)
        except Exception as exc:
            Logger.exception(f"Main: erro ao iniciar transmissor interno: {exc}")


if __name__ == "__main__":
    MainApp().run()
