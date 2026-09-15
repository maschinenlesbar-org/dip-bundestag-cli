# Builds this CLI's website from the repository itself.
#
# Reads ../package.json, the README (intro paragraph and quick start), the command
# tree of the built CLI (_data/cli.json, written by scripts/cli-reference.mjs),
# Usage.md, EXAMPLE.md, GLOSSARY.md, the Claude Code plugin and skills, and
# _data/project.yml (the only repo-specific texts), and exposes them as
# site.data["repo"].
#
# Every page exists in each language listed under `languages` in _config.yml: the
# default language at the root, the others under /<lang>/. Pages that translate
# each other share a `ref`, which the layout uses for the language switch and the
# hreflang links. Interface strings live in _data/i18n/<lang>.yml. A document can
# have a translation next to it (EXAMPLE.de.md); without one, the page in that
# language shows the English document.

require "json"
require "yaml"

module ProjectSite
  # Markdown documents rendered as pages, by slug, in navigation order.
  DOCS = { "usage" => "Usage.md", "examples" => "EXAMPLE.md", "glossary" => "GLOSSARY.md" }.freeze

  class Generator < Jekyll::Generator
    safe true
    priority :highest

    def generate(site)
      root = File.expand_path(site.config.fetch("project_root", ".."), site.source)
      languages = site.config.fetch("languages")
      default_lang = site.config.fetch("default_lang")
      i18n = site.data.fetch("i18n")
      check_translations(i18n, languages, default_lang)

      cli = site.data["cli"] or
        raise fatal("_data/cli.json is missing: run `npm run build` in the repository root, then `npm run build:cli` in site/")
      project = site.data.fetch("project")
      repository = site.config.fetch("repository")
      ref = ENV.fetch("SITE_REF", "main")
      blob = "https://github.com/#{repository}/blob/#{ref}"
      package = JSON.parse(File.read(File.join(root, "package.json")))
      readme = File.read(File.join(root, "README.md"))
      docs = DOCS.select { |_, file| File.exist?(File.join(root, file)) }
      baseurl = site.config.fetch("baseurl", "")
      prefix = ->(lang) { lang == default_lang ? "/" : "/#{lang}/" }
      link_context = ->(lang) { { baseurl: baseurl, prefix: prefix.call(lang), blob: blob, repository: repository, ref: ref, docs: docs, languages: languages } }

      intro_en = readme_intro(readme) or raise fatal("README.md has no intro paragraph")
      intro = languages.to_h do |lang|
        text = lang == default_lang ? intro_en : project.dig(lang, "intro")
        if text.to_s.strip.empty?
          Jekyll.logger.warn "Project site:", "no #{lang} intro in _data/project.yml, using English"
          [lang, { "markdown" => rewrite_links(intro_en, link_context.call(lang)), "lang" => default_lang }]
        else
          [lang, { "markdown" => rewrite_links(text.strip, link_context.call(lang)), "lang" => nil }]
        end
      end

      plugin_file = File.join(root, ".claude-plugin", "plugin.json")
      plugin = File.exist?(plugin_file) ? JSON.parse(File.read(plugin_file)) : nil

      site.data["repo"] = {
        "name" => repository.split("/").last,
        "repository" => repository,
        "ref" => ref,
        "github_url" => "https://github.com/#{repository}",
        "readme_url" => "https://github.com/#{repository}#readme",
        "package" => package.fetch("name"),
        "npm_url" => "https://www.npmjs.com/package/#{package.fetch("name")}",
        "version" => package.fetch("version"),
        "license" => package["license"],
        "description" => package["description"],
        "node" => package.dig("engines", "node").to_s[/\d+/],
        "bin" => cli.fetch("bin"),
        "intro" => intro,
        "quickstart" => quickstart(readme),
        "access" => project.fetch("access", { "type" => "open" }),
        "docs" => docs.keys,
        "plugin" => plugin && plugin["name"],
        "skills" => skills(root),
        "data_license_url" => File.exist?(File.join(root, "DATA_LICENSE.md")) ? "#{blob}/DATA_LICENSE.md" : nil,
        "licensing_url" => "#{blob}/LICENSING.md",
        "developing_url" => "#{blob}/DEVELOPING.md",
      }

      languages.each do |lang|
        add_page(site, lang, default_lang, "commands", "index.html",
                 "layout" => "commands", "ref" => "commands", "title" => i18n.dig(lang, "commands", "title"))

        docs.each do |slug, file|
          translated = translation(file, lang)
          source, doc_lang = File.exist?(File.join(root, translated)) ? [translated, lang] : [file, default_lang]
          markdown = File.read(File.join(root, source))
          title = markdown[/\A#\s+(.+)$/, 1] || slug.capitalize
          body = rewrite_links(markdown.sub(/\A#\s+.+\n/, ""), link_context.call(lang))
          add_page(site, lang, default_lang, slug, "index.md",
                   { "layout" => "doc", "ref" => "doc/#{slug}", "title" => i18n.dig(lang, "nav", slug) || title,
                     "doc_title" => title, "doc_lang" => doc_lang, "source_url" => "#{blob}/#{source}",
                     "render_with_liquid" => false },
                   body)
        end
      end
    end

    private

    def fatal(message)
      Jekyll::Errors::FatalException.new(message)
    end

    # EXAMPLE.md in German is EXAMPLE.de.md.
    def translation(file, lang)
      file.sub(/\.md\z/, ".#{lang}.md")
    end

    def add_page(site, lang, default_lang, slug, name, data, content = "")
      dir = lang == default_lang ? slug : File.join(lang, slug)
      page = Jekyll::PageWithoutAFile.new(site, site.source, dir, name)
      page.content = content
      page.data.merge!(data.merge("lang" => lang))
      site.pages << page
    end

    # Interface strings must exist in every language, with the same keys.
    def check_translations(i18n, languages, default_lang)
      reference = flat_keys(i18n.fetch(default_lang))
      languages.each do |lang|
        strings = i18n[lang] or raise fatal("_data/i18n/#{lang}.yml is missing")
        keys = flat_keys(strings)
        next if keys == reference

        raise fatal("_data/i18n/#{lang}.yml differs from #{default_lang}.yml: " \
                    "missing #{(reference - keys).inspect}, extra #{(keys - reference).inspect}")
      end
    end

    def flat_keys(hash, prefix = nil)
      hash.flat_map do |key, value|
        path = [prefix, key].compact.join(".")
        value.is_a?(Hash) ? flat_keys(value, path) : [path]
      end.sort
    end

    # The first plain paragraph before the first "## " heading: not a heading, badge
    # row, quote, list or the website link line.
    def readme_intro(readme)
      head = readme.split(/^## /, 2).first
      head.split(/\n\s*\n/).map(&:strip).find do |para|
        !para.empty? && !para.start_with?("#", "[![", ">", "- ", "* ", "**Website:**")
      end&.gsub(/\s*\n\s*/, " ")
    end

    # The first shell code block of the README's quick-start (or CLI/usage) section.
    def quickstart(readme)
      section = readme.split(/^(?=## )/).find { |s| s.match?(/\A## (Quick ?start|CLI|Usage)\b/i) }
      section && section[/^```(?:bash|sh|shell|console)?[ \t]*\n(.*?)^```/m, 1]&.rstrip
    end

    def skills(root)
      Dir.glob(File.join(root, "skills", "*", "SKILL.md")).sort.map do |file|
        front = File.read(file)[/\A---\s*\n(.*?)\n---\s*$/m, 1]
        meta = front ? YAML.safe_load(front) : {}
        meta["name"] || File.basename(File.dirname(file))
      end
    end

    # Rewrites repository-relative Markdown links (outside code blocks): the README and
    # the documents (and their translations) go to this site's pages in the same
    # language, images to raw.githubusercontent.com, everything else to the file on
    # GitHub at SITE_REF.
    def rewrite_links(markdown, ctx)
      markdown.split(/(^```.*?^```[ \t]*$)/m).each_with_index.map do |part, i|
        next part if i.odd?

        part
          .gsub(/(\]\()([^)\s]+)(\))/) { "#{$1}#{link_target($2, ctx)}#{$3}" }
          .gsub(/^(\[[^\]]+\]:\s*)(\S+)/) { "#{$1}#{link_target($2, ctx)}" }
      end.join
    end

    def link_target(target, ctx)
      return target if target.match?(%r{\A(?:[a-z][a-z0-9+.-]*:|#|/)}i)

      path, anchor = target.split("#", 2)
      path = path.delete_prefix("./")
      suffix = anchor ? "##{anchor}" : ""
      pages = { "README.md" => "" }
      ctx[:docs].each do |slug, file|
        [file, *ctx[:languages].map { |lang| translation(file, lang) }].each { |f| pages[f] = "#{slug}/" }
      end
      page = pages[path]
      if page
        "#{ctx[:baseurl]}#{ctx[:prefix]}#{page}#{suffix}"
      elsif path.match?(/\.(png|jpe?g|gif|svg|webp)\z/i)
        "https://raw.githubusercontent.com/#{ctx[:repository]}/#{ctx[:ref]}/#{path}"
      else
        "#{ctx[:blob]}/#{path}#{suffix}"
      end
    end
  end
end
