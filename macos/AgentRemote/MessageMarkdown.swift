import AppKit
import SwiftUI

struct MacMessageMarkdown: View {
    let text: String
    private var blocks: [MacMarkdownBlock] { MacMarkdownBlock.parse(text) }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block.kind {
                case .code:
                    VStack(alignment: .leading, spacing: 6) {
                        HStack { Text(block.language.isEmpty ? "Code" : block.language).font(.caption).foregroundStyle(.secondary); Spacer(); Button { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(block.text, forType: .string) } label: { Image(systemName: "doc.on.doc") }.accessibilityLabel("Copy code") }
                        ScrollView(.horizontal) { Text(block.text).font(.system(.callout, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: true, vertical: false) }
                    }.padding(12).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
                case .heading:
                    Text(inline(block.text)).font(block.level == 1 ? .title2.bold() : .headline).padding(.top, 6)
                case .bullet:
                    HStack(alignment: .top, spacing: 8) { Text(block.language); Text(inline(block.text)).frame(maxWidth: .infinity, alignment: .leading) }.padding(.leading, CGFloat(block.level) * 12)
                case .quote:
                    HStack { Rectangle().fill(.mint.opacity(0.5)).frame(width: 3); Text(inline(block.text)).foregroundStyle(.secondary) }.fixedSize(horizontal: false, vertical: true)
                case .table:
                    ScrollView(.horizontal) {
                        Grid(alignment: .topLeading, horizontalSpacing: 16, verticalSpacing: 8) {
                            ForEach(Array(tableRows(block.text).enumerated()), id: \.offset) { rowIndex, cells in
                                GridRow { ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in Text(inline(cell)).fontWeight(rowIndex == 0 ? .semibold : .regular).frame(minWidth: 80, maxWidth: 240, alignment: .leading).fixedSize(horizontal: false, vertical: true) } }
                                if rowIndex == 0 { Divider().gridCellUnsizedAxes(.horizontal) }
                            }
                        }.padding(10)
                    }.background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
                case .rule: Divider()
                case .paragraph: Text(inline(block.text)).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }.textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }
    private func tableRows(_ text: String) -> [[String]] {
        text.components(separatedBy: "\n").compactMap { line in
            let cells = line.trimmingCharacters(in: CharacterSet(charactersIn: "|")).components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
            if cells.allSatisfy({ $0.range(of: #"^:?-{3,}:?$"#, options: .regularExpression) != nil }) { return nil }
            return cells
        }
    }
    private func inline(_ text: String) -> AttributedString { (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text) }
}
struct MacMarkdownBlock {
    enum Kind { case paragraph, code, heading, bullet, quote, table, rule }
    var kind: Kind; var text: String; var language = ""; var level = 0
    static func parse(_ text: String) -> [MacMarkdownBlock] {
        let lines = text.components(separatedBy: "\n")
        var result: [MacMarkdownBlock] = []; var paragraph: [String] = []; var code: [String] = []; var fence: String?; var language = ""
        func flush() { if !paragraph.isEmpty { result.append(.init(kind: .paragraph, text: paragraph.joined(separator: "\n"))); paragraph = [] } }
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let marker = fence {
                if trimmed.hasPrefix(marker) { result.append(.init(kind: .code, text: code.joined(separator: "\n"), language: language)); code = []; fence = nil }
                else { code.append(line) }; continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { flush(); fence = String(trimmed.prefix(3)); language = String(trimmed.dropFirst(3)); continue }
            if trimmed.isEmpty { flush(); continue }
            if ["---", "***", "___"].contains(trimmed) { flush(); result.append(.init(kind: .rule, text: "")); continue }
            let hashes = trimmed.prefix { $0 == "#" }.count
            if (1...6).contains(hashes), trimmed.dropFirst(hashes).hasPrefix(" ") { flush(); result.append(.init(kind: .heading, text: String(trimmed.dropFirst(hashes + 1)), level: hashes)); continue }
            if trimmed.hasPrefix("> ") { flush(); result.append(.init(kind: .quote, text: String(trimmed.dropFirst(2)))); continue }
            if trimmed.hasPrefix("|"), trimmed.hasSuffix("|") { flush(); if result.last?.kind == .table { result[result.count-1].text += "\n" + trimmed } else { result.append(.init(kind: .table, text: trimmed)) }; continue }
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") { flush(); result.append(.init(kind: .bullet, text: String(trimmed.dropFirst(2)), language: "•", level: (line.count - trimmed.count) / 2)); continue }
            if let range = trimmed.range(of: #"^\d+[.)] "#, options: .regularExpression) { flush(); result.append(.init(kind: .bullet, text: String(trimmed[range.upperBound...]), language: String(trimmed[range]).trimmingCharacters(in: .whitespaces), level: (line.count-trimmed.count)/2)); continue }
            paragraph.append(line)
        }
        flush(); if fence != nil { result.append(.init(kind: .code, text: code.joined(separator: "\n"), language: language)) }; return result
    }
}
