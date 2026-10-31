import AVFoundation
import Speech
import SwiftUI

/// Hands microphone buffers to whichever recognition request is current; the tap runs on the audio thread.
private final class RequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    func set(_ value: SFSpeechAudioBufferRecognitionRequest?) { lock.lock(); request = value; lock.unlock() }
    func append(_ buffer: AVAudioPCMBuffer) { lock.lock(); let request = request; lock.unlock(); request?.append(buffer) }
}

@MainActor final class Voice: ObservableObject {
    @Published var recording = false
    @Published var transcript = ""
    @Published var error: String?
    private let engine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer()
    private let current = RequestBox()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var generation = 0
    private var taskStarted = Date.distantPast
    // On-device recognition starts a fresh transcription after each pause, so finished utterances are kept here
    // rather than being overwritten by the next one.
    private var committed: [String] = []
    private var partial = ""
    private var partialEnd: TimeInterval = 0
    private var finishing: CheckedContinuation<Void, Never>?
    private let speaker = AVSpeechSynthesizer()
    private var tapInstalled = false

    func start() async {
        stopSpeaking()
        let speech = await withCheckedContinuation { continuation in SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) } }
        let mic = await AVAudioApplication.requestRecordPermission()
        guard speech == .authorized, mic else { error = "Enable microphone and speech recognition access in Settings."; return }
        guard let recognizer, recognizer.isAvailable else { error = "Speech recognition is currently unavailable."; return }
        do {
            stop()
            committed = []; partial = ""; partialEnd = 0; transcript = ""; error = nil
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try audio.setActive(true)
            beginTask(recognizer)
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 else { throw AppError.message("No microphone is available.") }
            let current = current
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in current.append(buffer) }
            tapInstalled = true
            engine.prepare(); try engine.start(); recording = true
        } catch { stop(); self.error = error.localizedDescription }
    }
    /// Stops listening, waits briefly for the recognizer's last words, and returns the whole transcript.
    func finish() async -> String {
        guard recording else { return transcript }
        stopEngine(); recording = false
        request?.endAudio()
        if task != nil {
            let generation = generation
            await withCheckedContinuation { continuation in
                finishing = continuation
                Task { try? await Task.sleep(for: .seconds(2)); if self.generation == generation { self.resumeFinishing() } }
            }
        }
        commitPartial()
        let text = transcript
        stop()
        return text
    }
    func stop() {
        stopEngine()
        generation += 1
        current.set(nil)
        request?.endAudio(); task?.cancel(); task = nil; request = nil; recording = false
        resumeFinishing()
    }
    private func stopEngine() {
        engine.stop()
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
    }
    private func beginTask(_ recognizer: SFSpeechRecognizer) {
        generation += 1
        let generation = generation
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        self.request = request; current.set(request); taskStarted = Date()
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in self?.handle(result, error, generation: generation) }
        }
    }
    private func handle(_ result: SFSpeechRecognitionResult?, _ failure: Error?, generation: Int) {
        guard generation == self.generation else { return }
        if let result {
            let transcription = result.bestTranscription
            let text = transcription.formattedString
            if startsNewUtterance(transcription) { commitPartial() }
            // A result that extends (or repeats) the utterance just committed replaces it instead of duplicating it.
            if partial.isEmpty, let last = committed.last, text.hasPrefix(last) { committed.removeLast() }
            partial = text
            partialEnd = transcription.segments.last.map { $0.timestamp + $0.duration } ?? 0
            if result.speechRecognitionMetadata != nil { commitPartial() }
            transcript = (committed + [partial]).filter { !$0.isEmpty }.joined(separator: " ")
        }
        guard result?.isFinal == true || failure != nil else { return }
        commitPartial()
        if finishing != nil { resumeFinishing() }
        // The recognizer can end a task on its own mid-dictation; keep listening with a new one.
        else if recording, let recognizer, Date().timeIntervalSince(taskStarted) > 1 { beginTask(recognizer) }
        else { stop() }
    }
    private func startsNewUtterance(_ transcription: SFTranscription) -> Bool {
        guard !partial.isEmpty, let first = transcription.segments.first else { return false }
        if partialEnd > 0, first.timestamp > 0, first.timestamp >= partialEnd - 0.05 { return true }
        let old = partial.split(separator: " "), new = transcription.formattedString.split(separator: " ")
        return old.count >= 4 && new.count < old.count / 2 && old.first?.lowercased() != new.first?.lowercased()
    }
    private func commitPartial() {
        if !partial.isEmpty { committed.append(partial); partial = ""; partialEnd = 0 }
    }
    private func resumeFinishing() { finishing?.resume(); finishing = nil }
    func speak(_ text: String) {
        stop(); stopSpeaking()
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)
            let utterance = AVSpeechUtterance(string: text)
            utterance.rate = AVSpeechUtteranceDefaultSpeechRate
            speaker.speak(utterance)
        } catch { self.error = error.localizedDescription }
    }
    func stopSpeaking() { speaker.stopSpeaking(at: .immediate) }
}
