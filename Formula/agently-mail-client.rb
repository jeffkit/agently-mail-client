class AgentlyMailClient < Formula
  desc "Email Channel Adapter — routes emails to AI CLI profiles via AgentProc P0 protocol"
  homepage "https://github.com/jeffkit/agently-mail-client"
  url "https://registry.npmjs.org/agently-mail-client/-/agently-mail-client-0.1.0.tgz"
  sha256 "9c8708ffa4edab2083f0400cf7c58ee70596b5e48bb3494e51a81aa18b1adb7a"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  # brew services start agently-mail-client
  service do
    run [opt_bin/"agently-mail", "--config", etc/"agently-mail-client/email-profiles.yaml",
         "--interval", "600000"]
    working_dir var/"agently-mail-client"
    log_path    var/"log/agently-mail-client.log"
    error_log_path var/"log/agently-mail-client.log"
    environment_variables HOME: Dir.home, PATH: std_service_path_env
    keep_alive crashed: true
  end

  def post_install
    (var/"agently-mail-client").mkpath
    (etc/"agently-mail-client").mkpath

    # Copy example configs if they don't exist yet
    example_profiles = libexec/"lib/node_modules/agently-mail-client/email-profiles.example.yaml"
    target_profiles  = etc/"agently-mail-client/email-profiles.yaml"
    unless target_profiles.exist?
      target_profiles.write(example_profiles.read) if example_profiles.exist?
    end

    example_acl = libexec/"lib/node_modules/agently-mail-client/email-acl.example.yaml"
    target_acl  = etc/"agently-mail-client/email-acl.yaml"
    unless target_acl.exist?
      target_acl.write(example_acl.read) if example_acl.exist?
    end
  end

  def caveats
    <<~EOS
      #{name} has been installed. To get started:

      1. Login to Agently Mail (one-time browser auth):
           agently-cli auth login

      2. Edit your profile config:
           #{etc}/agently-mail-client/email-profiles.yaml

      3. Start the bridge:
           brew services start agently-mail-client

         Or run in the foreground:
           agently-mail --config #{etc}/agently-mail-client/email-profiles.yaml

      4. Open the dashboard:
           agently-mail dashboard --config #{etc}/agently-mail-client/email-profiles.yaml

      Logs: #{var}/log/agently-mail-client.log
      State: #{var}/agently-mail-client/
    EOS
  end

  test do
    assert_match "agently-mail", shell_output("#{bin}/agently-mail --help")
  end
end
