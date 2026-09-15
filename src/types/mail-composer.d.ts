declare module "nodemailer/lib/mail-composer/index.js" {
  import type { SendMailOptions } from "nodemailer";
  export default class MailComposer {
    constructor(mail: SendMailOptions);
    compile(): { build(cb: (err: Error | null, message: Buffer) => void): void };
  }
}
