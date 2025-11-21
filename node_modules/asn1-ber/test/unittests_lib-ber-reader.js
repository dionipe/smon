
var asn1 = require("../")
var assert = require("assert")

var BerReader = asn1.BerReader

describe("lib/ber/reader.js", function() {
	describe("readByte()", function() {
		it("can read a value", function() {
			var reader = new BerReader(Buffer.from([0xde]))
			assert.equal(reader.readByte(), 0xde)
		})
	})

	describe("readInt()", function() {
		it("can read zero", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x01, 0x00]))
			assert.equal(reader.readInt(), 0)
			assert.equal(reader.length, 1)
		})

		it("can read a 1 byte positive integer - lowest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x01, 0x01]))
			assert.equal(reader.readInt(), 1)
			assert.equal(reader.length, 1)
		})

		it("can read a 1 byte positive integer - middle", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x01, 0x34]))
			assert.equal(reader.readInt(), 52)
			assert.equal(reader.length, 1)
		})

		it("can read a 1 byte positive integer - highest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x01, 0x7f]))
			assert.equal(reader.readInt(), 127)
			assert.equal(reader.length, 1)
		})

		it("can read a 2 byte positive integer - lowest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x02, 0x00, 0x80]))
			assert.equal(reader.readInt(), 128)
			assert.equal(reader.length, 2)
		})

		it("can read a 2 byte positive integer - middle", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x02, 0x7e, 0xde]))
			assert.equal(reader.readInt(), 0x7ede)
			assert.equal(reader.length, 2)
		})

		it("can read a 2 byte positive integer - highest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x02, 0x7f, 0xff]))
			assert.equal(reader.readInt(), 32767)
			assert.equal(reader.length, 2)
		})

		it("can read a 3 byte positive integer - lowest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x03, 0x00, 0x80, 0x00]))
			assert.equal(reader.readInt(), 32768)
			assert.equal(reader.length, 3)
		})

		it("can read a 3 byte positive integer - middle", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x03, 0x7e, 0xde, 0x03]))
			assert.equal(reader.readInt(), 8314371)
			assert.equal(reader.length, 3)
		})

		it("can read a 3 byte positive integer - highest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x03, 0x7e, 0xde, 0x03]))
			assert.equal(reader.readInt(), 0x7ede03)
			assert.equal(reader.length, 0x03)
		})

		it("can read a 4 byte positive integer - lowest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x04, 0x00, 0x80, 0x00, 0x00]))
			assert.equal(reader.readInt(), 8388608)
			assert.equal(reader.length, 4)
		})

		it("can read a 4 byte positive integer - middle", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x04, 0x7e, 0xde, 0x03, 0x01]))
			assert.equal(reader.readInt(), 2128478977)
			assert.equal(reader.length, 4)
		})

		it("can read a 4 byte positive integer - highest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x04, 0x7f, 0xff, 0xff, 0xff]))
			assert.equal(reader.readInt(), 2147483647)
			assert.equal(reader.length, 4)
		})

		it("can read a 5 byte positive integer - lowest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x05, 0x00, 0x80, 0x00, 0x00, 0x00]))
			assert.equal(reader.readInt(), 2147483648)
			assert.equal(reader.length, 5)
		})

		it("can read a 5 byte positive integer - middle", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x05, 0x00, 0x8b, 0xde, 0x03, 0x01]))
			assert.equal(reader.readInt(), 2346582785)
			assert.equal(reader.length, 5)
		})

		it("can read a 5 byte positive integer - highest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x05, 0x00, 0xff, 0xff, 0xff, 0xff]))
			assert.equal(reader.readInt(), 4294967295)
			assert.equal(reader.length, 5)
		})

		it("can read a 1 byte negative integer - lowest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x01, 0x80]))
			assert.equal(reader.readInt(), -128)
			assert.equal(reader.length, 1)
		})

		it("can read a 1 byte negative integer - middle", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x01, 0xdc]))
			assert.equal(reader.readInt(), -36)
			assert.equal(reader.length, 1)
		})

		it("can read a 1 byte negative integer - highest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x01, 0xff]))
			assert.equal(reader.readInt(), -1)
			assert.equal(reader.length, 1)
		})

		it("can read a 2 byte negative integer - lowest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x02, 0x80, 0x00]))
			assert.equal(reader.readInt(), -32768)
			assert.equal(reader.length, 2)
		})

		it("can read a 2 byte negative integer - middle", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x02, 0xc0, 0x4e]))
			assert.equal(reader.readInt(), -16306)
			assert.equal(reader.length, 2)
		})

		it("can read a 2 byte negative integer - highest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x02, 0xff, 0x7f]))
			assert.equal(reader.readInt(), -129)
			assert.equal(reader.length, 2)
		})

		it("can read a 3 byte negative integer - lowest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x03, 0x80, 0x00, 0x00]))
			assert.equal(reader.readInt(), -8388608)
			assert.equal(reader.length, 3)
		})

		it("can read a 3 byte negative integer - middle", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x03, 0xff, 0x00, 0x19]))
			assert.equal(reader.readInt(), -65511)
			assert.equal(reader.length, 3)
		})

		it("can read a 3 byte negative integer - highest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x03, 0xff, 0x7f, 0xff]))
			assert.equal(reader.readInt(), -32769)
			assert.equal(reader.length, 3)
		})

		it("can read a 4 byte negative integer - lowest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x04, 0x80, 0x00, 0x00, 0x00]))
			assert.equal(reader.readInt(), -2147483648)
			assert.equal(reader.length, 4)
		})

		it("can read a 4 byte negative integer - middle", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x04, 0x91, 0x7c, 0x22, 0x1f]))
			assert.equal(reader.readInt(), -1854135777)
			assert.equal(reader.length, 4)
		})

		it("can read a 4 byte negative integer - highest", function() {
			var reader = new BerReader(Buffer.from([0x02, 0x04, 0xff, 0x7f, 0xff, 0xff]))
			assert.equal(reader.readInt(), -8388609)
			assert.equal(reader.length, 4)
		})
	})

	describe("readBoolean()", function() {
		it("can read a true value", function() {
			var reader = new BerReader(Buffer.from([0x01, 0x01, 0xff]))
			assert.equal(reader.readBoolean(), true)
			assert.equal(reader.length, 0x01)
		})

		it("can read a false value", function() {
			var reader = new BerReader(Buffer.from([0x01, 0x01, 0x00]))
			assert.equal(reader.readBoolean(), false)
			assert.equal(reader.length, 0x01)
		})
	})

	describe("readEnumeration()", function() {
		it("can read a value", function() {
			var reader = new BerReader(Buffer.from([0x0a, 0x01, 0x20]))
			assert.equal(reader.readEnumeration(), 0x20, 'wrong value')
			assert.equal(reader.length, 0x01, 'wrong length')
		})
	})

	describe("readOID()", function() {
		it("does not convert to unsigned", function() {
			// Make sure 2887117176 is NOT converted to -1407850120
			var buffer = Buffer.from([6, 18, 43, 6, 1, 4, 1, 245, 12, 1, 1, 5, 1, 1, 19, 138, 224, 215, 210, 120])
			var reader = new BerReader(buffer)
			assert.equal(reader.readOID(), "1.3.6.1.4.1.14988.1.1.5.1.1.19.2887117176")
			assert.equal(reader.length, 18)
		})
	})

	describe("readString()", function() {
		it("can read a value", function() {
			var string = 'cn=foo,ou=unit,o=test'
			var buffer = Buffer.alloc(string.length + 2)
			buffer[0] = 0x04
			buffer[1] = Buffer.byteLength(string)
			buffer.write(string, 2)

			var reader = new BerReader(buffer)
			assert.equal(reader.readString(), string)
			assert.equal(reader.length, string.length)
		})
	})

	describe("readSequence()", function() {
		it("can read a sequence", function() {
			var reader = new BerReader(Buffer.from([0x30, 0x03, 0x01, 0x01, 0xff]))
			assert.equal(reader.readSequence(), 0x30)
			assert.equal(reader.length, 0x03)
			assert.equal(reader.readBoolean(), true)
			assert.equal(reader.length, 0x01)
		})
	})

	describe("readBitString()", function() {
		it("can read a bit string", function() {
			var reader = new BerReader(Buffer.from([0x03, 0x07, 0x04, 0x0a, 0x3b, 0x5f, 0x29, 0x1c, 0xd0]))
			assert.equal(reader.readBitString(), '00001010001110110101111100101001000111001101')
			assert.equal(reader.length, 7)
		})
	})

	describe("complex sequences", function() {
		it("are processed correctly", function() {
			var buffer = Buffer.alloc(14);

			// An anonymous LDAP v3 BIND request
			buffer[0]  = 0x30 // Sequence
			buffer[1]  = 12   // len
			buffer[2]  = 0x02 // ASN.1 Integer
			buffer[3]  = 1    // len
			buffer[4]  = 0x04 // msgid (make up 4)
			buffer[5]  = 0x60 // Bind Request
			buffer[6]  = 7    // len
			buffer[7]  = 0x02 // ASN.1 Integer
			buffer[8]  = 1    // len
			buffer[9]  = 0x03 // v3
			buffer[10] = 0x04 // String (bind dn)
			buffer[11] = 0    // len
			buffer[12] = 0x80 // ContextSpecific (choice)
			buffer[13] = 0    // simple bind

			var reader = new BerReader(buffer)
			assert.equal(reader.readSequence(), 48)
			assert.equal(reader.length, 12)
			assert.equal(reader.readInt(), 4)
			assert.equal(reader.readSequence(), 96)
			assert.equal(reader.length, 7)
			assert.equal(reader.readInt(), 3)
			assert.equal(reader.readString(), "")
			assert.equal(reader.length, 0)
			assert.equal(reader.readByte(), 0x80)
			assert.equal(reader.readByte(), 0)
			assert.equal(null, reader.readByte())
		})
	})

	describe("long strings", function() {
		it("can be parsed", function() {
			var buffer = Buffer.alloc(256)
			var string = "2;649;CN=Red Hat CS 71GA Demo,O=Red Hat CS 71GA Demo,C=US;"
					+ "CN=RHCS Agent - admin01,UID=admin01,O=redhat,C=US [1] This is "
					+ "Teena Vradmin's description."
			buffer[0] = 0x04
			buffer[1] = 0x81
			buffer[2] = 0x94
			buffer.write(string, 3)

			var reader = new BerReader(buffer.slice(0, 3 + string.length));
			assert.equal(reader.readString(), string)
		})
	})
})
