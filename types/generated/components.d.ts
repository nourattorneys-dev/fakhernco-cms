import type { Schema, Struct } from '@strapi/strapi';

export interface BlocksButton extends Struct.ComponentSchema {
  collectionName: 'components_blocks_buttons';
  info: {
    displayName: 'Button';
    icon: 'cursor';
  };
  attributes: {
    href: Schema.Attribute.String & Schema.Attribute.Required;
    text: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface BlocksCardItem extends Struct.ComponentSchema {
  collectionName: 'components_blocks_card_items';
  info: {
    displayName: 'Card';
    icon: 'layer';
  };
  attributes: {
    href: Schema.Attribute.String;
    text: Schema.Attribute.Text;
    title: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface BlocksCards extends Struct.ComponentSchema {
  collectionName: 'components_blocks_cards';
  info: {
    description: "Grid of titled cards - the theme's icon-box component, e.g. the six core values on /our-unwavering-principles/ and the contact tiles.";
    displayName: 'Card grid';
    icon: 'grid';
  };
  attributes: {
    items: Schema.Attribute.Component<'blocks.card-item', true>;
  };
}

export interface BlocksDataTable extends Struct.ComponentSchema {
  collectionName: 'components_blocks_data_tables';
  info: {
    description: 'Header row plus body rows, both stored as JSON arrays.';
    displayName: 'Table';
    icon: 'grid';
  };
  attributes: {
    headers: Schema.Attribute.JSON;
    rows: Schema.Attribute.JSON;
  };
}

export interface BlocksFaq extends Struct.ComponentSchema {
  collectionName: 'components_blocks_faqs';
  info: {
    description: 'Accordion of question/answer pairs. Rendered with FAQPage structured data.';
    displayName: 'FAQ';
    icon: 'question';
  };
  attributes: {
    items: Schema.Attribute.Component<'blocks.faq-item', true>;
  };
}

export interface BlocksFaqItem extends Struct.ComponentSchema {
  collectionName: 'components_blocks_faq_items';
  info: {
    displayName: 'FAQ item';
    icon: 'question';
  };
  attributes: {
    answer: Schema.Attribute.Text & Schema.Attribute.Required;
    question: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface BlocksGallery extends Struct.ComponentSchema {
  collectionName: 'components_blocks_galleries';
  info: {
    description: 'A set of images shown together. Carousels on the WordPress site import as galleries \u2014 a slider is one piece of content, not N stacked figures.';
    displayName: 'Gallery';
    icon: 'picture';
  };
  attributes: {
    items: Schema.Attribute.Component<'blocks.gallery-item', true>;
  };
}

export interface BlocksGalleryItem extends Struct.ComponentSchema {
  collectionName: 'components_blocks_gallery_items';
  info: {
    displayName: 'Gallery item';
    icon: 'picture';
  };
  attributes: {
    alt: Schema.Attribute.String;
    file: Schema.Attribute.Media<'images'>;
    legacySrc: Schema.Attribute.String;
  };
}

export interface BlocksHeading extends Struct.ComponentSchema {
  collectionName: 'components_blocks_headings';
  info: {
    description: 'Section heading. H1 is deliberately excluded - the page template owns it, because 49 documents on the WordPress site carry more than one H1.';
    displayName: 'Heading';
    icon: 'text';
  };
  attributes: {
    level: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          max: 4;
          min: 2;
        },
        number
      > &
      Schema.Attribute.DefaultTo<2>;
    text: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface BlocksImage extends Struct.ComponentSchema {
  collectionName: 'components_blocks_images';
  info: {
    displayName: 'Image';
    icon: 'picture';
  };
  attributes: {
    alt: Schema.Attribute.String;
    file: Schema.Attribute.Media<'images'>;
    legacySrc: Schema.Attribute.String;
  };
}

export interface BlocksList extends Struct.ComponentSchema {
  collectionName: 'components_blocks_lists';
  info: {
    displayName: 'List';
    icon: 'bulletList';
  };
  attributes: {
    items: Schema.Attribute.Component<'blocks.list-item', true>;
    ordered: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
  };
}

export interface BlocksListItem extends Struct.ComponentSchema {
  collectionName: 'components_blocks_list_items';
  info: {
    displayName: 'List item';
    icon: 'bulletList';
  };
  attributes: {
    text: Schema.Attribute.Text & Schema.Attribute.Required;
  };
}

export interface BlocksParagraph extends Struct.ComponentSchema {
  collectionName: 'components_blocks_paragraphs';
  info: {
    displayName: 'Paragraph';
    icon: 'align-left';
  };
  attributes: {
    html: Schema.Attribute.RichText & Schema.Attribute.Required;
  };
}

export interface BlocksQuote extends Struct.ComponentSchema {
  collectionName: 'components_blocks_quotes';
  info: {
    displayName: 'Quote';
    icon: 'quote';
  };
  attributes: {
    attribution: Schema.Attribute.String;
    html: Schema.Attribute.RichText & Schema.Attribute.Required;
  };
}

export interface SharedCta extends Struct.ComponentSchema {
  collectionName: 'components_shared_ctas';
  info: {
    displayName: 'Call to action';
    icon: 'bell';
  };
  attributes: {
    buttonHref: Schema.Attribute.String;
    buttonLabel: Schema.Attribute.String;
    text: Schema.Attribute.Text;
    title: Schema.Attribute.String;
  };
}

export interface SharedSeo extends Struct.ComponentSchema {
  collectionName: 'components_shared_seos';
  info: {
    displayName: 'SEO';
    icon: 'search';
  };
  attributes: {
    canonicalUrl: Schema.Attribute.String;
    metaDescription: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }>;
    metaTitle: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 200;
      }>;
    noIndex: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    ogImage: Schema.Attribute.Media<'images'>;
  };
}

declare module '@strapi/strapi' {
  export namespace Public {
    export interface ComponentSchemas {
      'blocks.button': BlocksButton;
      'blocks.card-item': BlocksCardItem;
      'blocks.cards': BlocksCards;
      'blocks.data-table': BlocksDataTable;
      'blocks.faq': BlocksFaq;
      'blocks.faq-item': BlocksFaqItem;
      'blocks.gallery': BlocksGallery;
      'blocks.gallery-item': BlocksGalleryItem;
      'blocks.heading': BlocksHeading;
      'blocks.image': BlocksImage;
      'blocks.list': BlocksList;
      'blocks.list-item': BlocksListItem;
      'blocks.paragraph': BlocksParagraph;
      'blocks.quote': BlocksQuote;
      'shared.cta': SharedCta;
      'shared.seo': SharedSeo;
    }
  }
}
