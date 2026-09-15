export type TextStyle = {
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  lineHeight?: string;
};

export type Block =
  | {
      id: string;
      type: "text";
      content: string;
      style?: TextStyle;
    }
  | {
      id: string;
      type: "field";
      field: string;
      prefix?: string;
      suffix?: string;
      style?: TextStyle;
      link?: "email" | "phone" | "url" | "none";
    }
  | {
      id: string;
      type: "image";
      src: string;
      width?: number;
      alt?: string;
      href?: string;
    }
  | {
      id: string;
      type: "social";
      networks: Array<{ name: "linkedin" | "x" | "facebook" | "instagram" | "website"; urlField?: string; url?: string }>;
      iconSize?: number;
    }
  | {
      id: string;
      type: "divider";
      color?: string;
      height?: number;
    }
  | {
      id: string;
      type: "spacer";
      height?: number;
    }
  | {
      id: string;
      type: "banner";
      src: string;
      href?: string;
      alt?: string;
      width?: number;
    }
  | {
      id: string;
      type: "row";
      columns: Array<{ width: string; blocks: Block[] }>;
    };

export type Design = {
  width: number;
  background?: string;
  blocks: Block[];
};

export function newBlockId(): string {
  return `b_${Math.random().toString(36).slice(2, 10)}`;
}
