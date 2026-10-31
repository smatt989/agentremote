import SwiftUI
import AVFoundation

struct QRScanner: UIViewControllerRepresentable {
    var found: (String) -> Void
    var failed: (String) -> Void
    func makeUIViewController(context: Context) -> QRScannerController {
        let controller = QRScannerController(); controller.found = found; controller.failed = failed; return controller
    }
    func updateUIViewController(_ controller: QRScannerController, context: Context) {}
}
final class QRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var found: ((String) -> Void)?
    var failed: ((String) -> Void)?
    private let capture = AVCaptureSession()
    private let queue = DispatchQueue(label: "AgentRemote.Camera")
    private var preview: AVCaptureVideoPreviewLayer?
    private var scanned = false
    private var visible = false
    override func viewDidLoad() { super.viewDidLoad(); view.backgroundColor = .black }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated); visible = true
        AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
            DispatchQueue.main.async {
                guard let self, self.visible else { return }
                guard allowed else { self.failed?("Allow camera access in Settings, or paste a pairing code instead."); return }
                self.configure()
            }
        }
    }
    private func configure() {
        guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera), capture.canAddInput(input) else { failed?("No camera is available. Paste a pairing code instead."); return }
        capture.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard capture.canAddOutput(output) else { failed?("The camera could not start."); return }
        capture.addOutput(output); output.setMetadataObjectsDelegate(self, queue: .main); output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: capture); preview.videoGravity = .resizeAspectFill; preview.frame = view.bounds
        view.layer.addSublayer(preview); self.preview = preview
        queue.async { [capture] in capture.startRunning() }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); preview?.frame = view.bounds }
    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); visible = false; queue.async { [capture] in capture.stopRunning() } }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !scanned, let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject, let code = object.stringValue else { return }
        scanned = true; found?(code)
    }
}
